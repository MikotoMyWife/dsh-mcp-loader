/**
 * Real MCP stdio server used by the e2e test.
 *
 * Exposes six tools over the real MCP SDK, including `add_tool`, which grows
 * the tool list at runtime and emits `notifications/tools/list_changed` so the
 * plugin's re-sync path is exercised end to end, and `die`, which crashes the
 * process so the transport-failure path is exercised too.
 *
 * Fault-injection and observability env (see the e2e coverage table):
 * - `ECHO_FAIL_FIRST_CONNECT=1` + `ECHO_MARKER=<file>`: the first process that
 *   atomically creates the marker (`openSync(..., 'wx')`) exits right after
 *   boot, simulating a first-connect crash; every later process sees the
 *   marker and serves normally.
 * - `ECHO_LOG=<file>`: appends one line per event — `start` at boot and the
 *   raw tool name for each `tools/call` — for deterministic process/call
 *   counting.
 * - `ECHO_EXIT_MARKER=<file>`: writes `closed` when the process exits, proving
 *   an idle disconnect actually terminated it.
 *
 * Per-server disambiguation comes from `ECHO_LOG` pointing at a distinct file
 * per server, so no extra id env is needed.
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
      properties: {
        text: {
          type: 'string',
          description: 'A deliberately long parameter description that a configured cap must truncate.',
        },
      },
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
    outputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
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

// First-connect failure injection: whoever wins the atomic marker creation is
// "the first attempt" and dies on arrival; retries spawn fresh processes that
// serve normally.
if (process.env.ECHO_FAIL_FIRST_CONNECT === '1' && process.env.ECHO_MARKER !== undefined) {
  try {
    fs.openSync(process.env.ECHO_MARKER, 'wx')
    process.exit(1)
  } catch {
    // The marker already exists: an earlier process already played the crash.
  }
}

const server = new Server(
  { name: 'echo-fixture', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true } } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

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
    case 'structured':
      // Deliberately violates the declared outputSchema, the way inkstone's
      // `search` does: a client that pre-validates structuredContent fails here.
      return {
        content: [{ type: 'text', text: 'structured ok' }],
        structuredContent: { value: 'x', extra: 'not in the schema' },
      }
    case 'die':
      // Crash mid-call: the response never arrives and the client sees the
      // transport die. Deliberately no response.
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

// Exit when the parent closes stdin (idle disconnect or harness teardown):
// without this the child lingers until it is force-killed, and the exit marker
// would never be written on Windows. This listener is registered before the
// SDK transport's own stdin 'end' listener (registered by `connect` below), so
// ours fires first and exits the process immediately.
process.stdin.on('end', () => {
  markClosed()
  process.exit(0)
})

await server.connect(new StdioServerTransport())
