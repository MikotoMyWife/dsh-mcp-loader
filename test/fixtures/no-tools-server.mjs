/**
 * Hand-rolled MCP stdio server that advertises **no** tools capability, used to
 * pin the loader's disposition for a server whose tool list cannot exist
 * (a resources-only or prompts-only server). The load must succeed with an
 * empty catalogue instead of failing, and the plugin must not even ask for a
 * list: every `tools/list` request would be logged as `list`.
 *
 * Speaking the wire protocol directly also proves the short circuit is ours
 * rather than the client library's.
 */
import fs from 'node:fs'

const ECHO_LOG = process.env.ECHO_LOG
const logLine = (line) => {
  if (ECHO_LOG !== undefined) fs.appendFileSync(ECHO_LOG, `${line}\n`)
}

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
        // The point of this fixture: no `tools` capability at all.
        capabilities: {},
        serverInfo: { name: 'no-tools-fixture', version: '1.0.0' },
      },
    })
    return
  }
  if (message.method === 'notifications/initialized' || message.id === undefined) return
  if (message.method === 'tools/list') {
    logLine('list')
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [] } })
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
