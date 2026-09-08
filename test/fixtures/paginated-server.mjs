/**
 * Real MCP stdio server with pagination and deterministic timing hooks, used
 * by the discovery-cap and monotonic-generation e2e checks (slice 03).
 *
 * Tool table matches the echo fixture (six tools incl. `add_tool`/`new_tool`)
 * so callable assertions stay interchangeable. Timing and growth are driven by
 * env, following the shared fixture convention (`ECHO_LOG`, `ECHO_EXIT_MARKER`):
 *
 * - `ECHO_PAGINATE=1`: paginate `tools/list` with pageSize 2 (3 pages for the
 *   six tools); without it one page returns everything.
 * - `ECHO_HANG_MS=<n>`: every `tools/list` request sleeps <n> ms before
 *   answering — a deterministic hang for the discovery-timeout cap.
 * - `ECHO_NOTIFY1_MS=<n>` / `ECHO_NOTIFY2_MS=<n>`: <n> ms after boot, grow the
 *   tool list (`late_a`, then `late_b`) and emit `notifications/tools/
 *   list_changed` — two timed changes that make two concurrent re-syncs.
 * - `ECHO_LIST_DELAY_MS=<n>`: every `tools/list` request sleeps <n> ms.
 * - `ECHO_SLOW_LIST_INDEX=<i>` + `ECHO_SLOW_LIST_MS=<n>`: the <i>-th
 *   `tools/list` request of this process sleeps <n> ms instead of the base
 *   delay — makes that discovery finish last, deterministically, regardless of
 *   wall-clock jitter (used to prove the late older snapshot is discarded).
 * - `ECHO_LOG`: appends `start` at boot, `list` per `tools/list` request, and
 *   the raw tool name per `tools/call`.
 * - `ECHO_EXIT_MARKER`: writes `closed` when the process exits.
 */
import fs from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const tools = [
  {
    name: 'echo',
    description: 'Echo back the given text.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'add',
    description: 'Add two numbers and return the sum as text.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
  {
    name: 'fail',
    description: 'Always returns an MCP tool error.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'die',
    description: 'Exits the fixture process immediately (simulates a server crash).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add_tool',
    description: 'Adds a new tool named new_tool and announces the change.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'structured',
    description: 'Declares an output schema but returns extra structured properties.',
    inputSchema: { type: 'object', properties: {} },
  },
]

const ECHO_LOG = process.env.ECHO_LOG
const ECHO_EXIT_MARKER = process.env.ECHO_EXIT_MARKER

function logLine(line) {
  if (ECHO_LOG !== undefined) fs.appendFileSync(ECHO_LOG, `${line}\n`)
}

function markClosed() {
  if (ECHO_EXIT_MARKER !== undefined) fs.writeFileSync(ECHO_EXIT_MARKER, 'closed')
}

process.on('exit', markClosed)

logLine('start')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const server = new Server(
  { name: 'paginated-fixture', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true } } },
)

const PAGINATE = process.env.ECHO_PAGINATE === '1'
const PAGE_SIZE = 2
const HANG_MS = Number(process.env.ECHO_HANG_MS ?? 0)
const BASE_LIST_DELAY_MS = Number(process.env.ECHO_LIST_DELAY_MS ?? 0)
const SLOW_LIST_INDEX = Number(process.env.ECHO_SLOW_LIST_INDEX ?? 0)
const SLOW_LIST_MS = Number(process.env.ECHO_SLOW_LIST_MS ?? 0)
const NOTIFY1_MS = Number(process.env.ECHO_NOTIFY1_MS ?? 0)
const NOTIFY2_MS = Number(process.env.ECHO_NOTIFY2_MS ?? 0)

/** The <i>-th `tools/list` request of this process (1-based, per page). */
let listRequestIndex = 0

async function growLate(name, notifyAt) {
  if (notifyAt <= 0 || tools.some((tool) => tool.name === name)) return
  await sleep(notifyAt)
  if (tools.some((tool) => tool.name === name)) return
  tools.push({
    name,
    description: `A tool that appeared after startup (${name}).`,
    inputSchema: { type: 'object', properties: {} },
  })
  await server.sendToolListChanged()
}

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  logLine('list')
  listRequestIndex += 1
  const isSlow = SLOW_LIST_INDEX > 0 && listRequestIndex === SLOW_LIST_INDEX
  const delay = HANG_MS > 0 ? HANG_MS : isSlow ? SLOW_LIST_MS : BASE_LIST_DELAY_MS
  if (delay > 0) await sleep(delay)
  const cursor = request.params?.cursor
  if (!PAGINATE) return { tools }
  // Cursors are the next start index: c0 → tools[0..1], c2 → tools[2..3], …
  const start = cursor === undefined ? 0 : Number(cursor.slice(1))
  const slice = tools.slice(start, start + PAGE_SIZE)
  const nextStart = start + PAGE_SIZE
  return { tools: slice, ...(nextStart < tools.length ? { nextCursor: `c${nextStart}` } : {}) }
})

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params
  logLine(name)
  switch (name) {
    case 'echo':
      return { content: [{ type: 'text', text: `echo:${String(args.text ?? '')}` }] }
    case 'add':
      return { content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }] }
    case 'fail':
      return { content: [{ type: 'text', text: 'fixture failure' }], isError: true }
    case 'new_tool':
      return { content: [{ type: 'text', text: 'new_tool ok' }] }
    case 'late_a':
      return { content: [{ type: 'text', text: 'late_a ok' }] }
    case 'late_b':
      return { content: [{ type: 'text', text: 'late_b ok' }] }
    case 'structured':
      return { content: [{ type: 'text', text: 'structured ok' }] }
    case 'die':
      process.exit(1)
      break
    case 'add_tool': {
      if (!tools.some((tool) => tool.name === 'new_tool')) {
        tools.push({
          name: 'new_tool',
          description: 'A tool that appeared after startup.',
          inputSchema: { type: 'object', properties: {} },
        })
      }
      await server.sendToolListChanged()
      return { content: [{ type: 'text', text: 'added new_tool' }] }
    }
    default:
      return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true }
  }
})

// Exit when the parent closes stdin (idle disconnect or harness teardown);
// registered before the SDK transport's own stdin 'end' listener.
process.stdin.on('end', () => {
  markClosed()
  process.exit(0)
})

await server.connect(new StdioServerTransport())

void growLate('late_a', NOTIFY1_MS)
void growLate('late_b', NOTIFY2_MS)
