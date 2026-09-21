/**
 * Hand-rolled MCP stdio server whose one tool answers with a result that is
 * invalid per the MCP spec but valid for this bridge: a text block without its
 * required `text` field. It pins the "we own no output contract" stance — the
 * plugin reads `tools/call` through its own accept-anything result schema, so
 * the payload reaches the renderer instead of failing the call.
 *
 * It speaks the newline-delimited JSON-RPC wire protocol directly instead of
 * using the SDK's server class, because that server validates its own outgoing
 * results and refuses to send this one (`-32602 Invalid tools/call result`) —
 * a spec-invalid payload can only exist on the wire if nothing filters it.
 */
process.stdin.setEncoding('utf8')

const TOOLS = [
  {
    name: 'odd',
    description: 'Answer with a spec-invalid text block (missing its "text" field).',
    inputSchema: { type: 'object', properties: {} },
  },
]

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

function handle(message) {
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        // Echo the client's requested revision: this fixture tests results, not
        // version negotiation.
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'raw-protocol-fixture', version: '1.0.0' },
      },
    })
    return
  }
  if (message.method === 'notifications/initialized' || message.id === undefined) return
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } })
    return
  }
  if (message.method === 'tools/call') {
    // Deliberately spec-invalid: a text block without its required `text`
    // field. The spec validator rejects it; our own result schema accepts it.
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text' }] } })
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
