/**
 * Hand-rolled MCP stdio server exposing one tool plus one resource, used to
 * prove the resource bridge end to end: once a session expands the server, the
 * host's shared resource tools reach this connection and read the fixture's
 * resource; before that, no resource surface exists.
 *
 * `ECHO_LOG` records `start`, `list` per `tools/list` and `read` per
 * `resources/read`.
 */
import fs from 'node:fs'

const ECHO_LOG = process.env.ECHO_LOG
const logLine = (line) => {
  if (ECHO_LOG !== undefined) fs.appendFileSync(ECHO_LOG, `${line}\n`)
}

const RESOURCE_URI = 'fixture://doc/readme'
const RESOURCE_TEXT = 'resource body from the fixture'

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
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: { name: 'resources-fixture', version: '1.0.0' },
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
          { name: 'ping', description: 'Answer with pong.', inputSchema: { type: 'object', properties: {} } },
        ],
      },
    })
    return
  }
  if (message.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'pong' }] } })
    return
  }
  if (message.method === 'resources/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        resources: [{ uri: RESOURCE_URI, name: 'Fixture readme', mimeType: 'text/plain' }],
      },
    })
    return
  }
  if (message.method === 'resources/templates/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { resourceTemplates: [] } })
    return
  }
  if (message.method === 'resources/read') {
    logLine('read')
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        contents: [{ uri: message.params?.uri ?? RESOURCE_URI, mimeType: 'text/plain', text: RESOURCE_TEXT }],
      },
    })
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
