/**
 * Real MCP stdio server used by the e2e test.
 *
 * Exposes four tools over the real MCP SDK, including `add_tool`, which grows
 * the tool list at runtime and emits `notifications/tools/list_changed` so the
 * plugin's re-sync path is exercised end to end.
 */
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

const server = new Server(
  { name: 'echo-fixture', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true } } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params
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

await server.connect(new StdioServerTransport())
