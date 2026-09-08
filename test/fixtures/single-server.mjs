/**
 * Real MCP stdio server exposing exactly one tool, used to prove that a
 * single-tool MCP is registered eagerly instead of getting a loader tool.
 *
 * Supports the shared fixture observability env: `ECHO_LOG` appends a `start`
 * line per process and the raw tool name per `tools/call`; `ECHO_EXIT_MARKER`
 * writes `closed` on exit (see the echo fixture for the full convention).
 */
import fs from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const tools = [
  {
    name: 'ping',
    description: 'Answer with pong.',
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

const server = new Server(
  { name: 'single-fixture', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true } } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params
  logLine(name)
  if (name === 'ping') return { content: [{ type: 'text', text: 'pong' }] }
  return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true }
})

// Exit when the parent closes stdin (idle disconnect or harness teardown).
process.stdin.on('end', () => {
  markClosed()
  process.exit(0)
})

await server.connect(new StdioServerTransport())
