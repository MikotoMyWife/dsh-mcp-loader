/**
 * Real MCP stdio server exposing exactly one tool, used to prove that a
 * single-tool MCP is registered eagerly instead of getting a loader tool.
 */
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

const server = new Server(
  { name: 'single-fixture', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true } } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'ping') return { content: [{ type: 'text', text: 'pong' }] }
  return { content: [{ type: 'text', text: `unknown tool ${request.params.name}` }], isError: true }
})

await server.connect(new StdioServerTransport())
