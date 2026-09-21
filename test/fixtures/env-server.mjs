/**
 * Real MCP stdio server whose one tool reports the environment it was started
 * with, so the plugin's child-environment contract (credential scrubbing, proxy
 * passthrough, config overlay) can be asserted on the real spawn path rather
 * than on the value the plugin meant to pass.
 *
 * The report is a fixed key list, one `KEY=value` line per key, with `(absent)`
 * for a key the child did not receive — a fixed list keeps the fixture from
 * dumping unrelated host facts into the test output.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

/** Credential-shaped keys the scrub must withhold, plus the keys it must keep. */
const REPORTED_KEYS = [
  'PATH',
  'HTTPS_PROXY',
  'NODE_USE_ENV_PROXY',
  'NPM_CONFIG_REGISTRY',
  'MCP_EXTRA',
  'MCP_FAKE_TOKEN',
  'MCP_FAKE_PASSWORD',
  'MCP_FAKE_KEY',
  'DSH_FAKE_FACT',
]

const tools = [
  {
    name: 'env_report',
    description: 'Report the environment this server process was started with.',
    inputSchema: { type: 'object', properties: {} },
  },
]

const server = new Server(
  { name: 'env-fixture', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true } } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'env_report') {
    return { content: [{ type: 'text', text: `unknown tool ${request.params.name}` }], isError: true }
  }
  const report = REPORTED_KEYS.map((key) => `${key}=${process.env[key] ?? '(absent)'}`).join('\n')
  return { content: [{ type: 'text', text: report }] }
})

// Exit when the parent closes stdin (idle disconnect or harness teardown).
process.stdin.on('end', () => process.exit(0))

await server.connect(new StdioServerTransport())
