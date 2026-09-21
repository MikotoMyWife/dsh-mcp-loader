/**
 * Hand-rolled MCP stdio server that sends its own `instructions` in the
 * handshake and exposes one tool, so the loader's instruction surface and the
 * `maxInstructionBytes` ceiling are asserted on the real wire.
 *
 * `ECHO_INSTRUCTION=<text>` sets the instruction block; the default is short.
 * Every `tools/list` request is logged as `list` so the load path stays
 * observable.
 */
import fs from 'node:fs'

const ECHO_LOG = process.env.ECHO_LOG
const logLine = (line) => {
  if (ECHO_LOG !== undefined) fs.appendFileSync(ECHO_LOG, `${line}\n`)
}

const INSTRUCTIONS = process.env.ECHO_INSTRUCTION ?? 'Prefer the short path: read before writing.'

process.stdin.setEncoding('utf8')
logLine('start')

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

function handle(message) {
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'instructions-fixture', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      },
    })
    return
  }
  if (message.method === 'notifications/initialized' || message.id === undefined) return
  if (message.method === 'tools/list') {
    logLine('list')
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          {
            name: 'ping',
            description: 'Answer with pong.',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
    })
    return
  }
  if (message.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'pong' }] } })
    return
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } })
}

let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let at
  while ((at = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    if (line.trim() === '') continue
    handle(JSON.parse(line))
  }
})

// Exit when the parent closes stdin (idle disconnect or harness teardown).
process.stdin.on('end', () => process.exit(0))
