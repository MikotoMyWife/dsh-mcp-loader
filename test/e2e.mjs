/**
 * Real-path end-to-end test for the lazy-loading MCP plugin (loader-tool design).
 *
 * Everything below is the real chain: a real Cordis context, the real
 * `@deepseek-ai/dsh-system-prompt` and `@deepseek-ai/dsh-tools` ToolRuntime from
 * the installed harness, the plugin loaded from its compiled `lib/`, the real
 * MCP TypeScript SDK client, and real stdio MCP server subprocesses
 * (`test/fixtures/*.mjs`). No harness component is stubbed.
 *
 * Tool calls go through `ctx.tools.execute()` — the same dispatch entry point
 * the agent loop uses — so argument validation, the registration layers, and
 * the result projection are all exercised.
 *
 * Coverage table
 * | # | Action                                        | Expected                                                   |
 * |---|-----------------------------------------------|------------------------------------------------------------|
 * | 1 | mount with a 4-tool server                    | only its loader is visible, its real tools are hidden      |
 * | 2 | loader description                            | server description + loader hint                           |
 * | 3 | mount with a 1-tool server (auto)             | that tool is visible, no loader for it                     |
 * | 4 | call the eagerly registered tool              | works                                                      |
 * | 5 | call the loader                               | returns exactly `ok`; the server's tools become visible    |
 * | 6 | call a tool that the loader just revealed     | works through the real registry                            |
 * | 7 | typed arguments                               | reach the MCP server                                       |
 * | 8 | MCP isError result                            | settles as an error result                                 |
 * | 9 | list_changed                                  | the loaded generation is swapped and the new tool is live   |
 * | 10| call the loader twice, then a third time             | hides on the second call, reveals again on the third      |
 * | 11| per-agent restrict() on a revealed tool       | hides it in that scope only                                |
 * | 12| assembled model request                       | lacks the tool before the loader call, has it after        |
 * | 13| mode: eager (4-tool server)                   | tools visible at mount, no loader                          |
 * | 14| mode: lazy (1-tool server)                    | loader present, tool hidden until the loader is called     |
 * | 15| tool whose structured content breaks its own output schema | still callable (live inkstone `search` regression) |
 * | 16| call the loader a second time                    | hides the tools; a third call reveals them again         |
 * | 17| hiddenTools masks a loaded server                 | masked for that agent, still global for everyone else    |
 * | 18| toolDescriptions + parameter cap                  | rewritten description and truncated parameter text       |
 * | 19| unknown descriptionPreset                         | plugin stays unmounted (fail fast)                       |
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const DSH_PACKAGES = process.env.DSH_PACKAGES
  ?? 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const load = (rel) => import(pathToFileURL(`${DSH_PACKAGES}/${rel}`).href)

const { Context } = await load('cordis/lib/index.js')
const SystemPrompt = (await load('dsh-system-prompt/lib/index.js')).default
const ToolRuntime = (await load('dsh-tools/lib/index.js')).default
const { createScope } = await load('dsh-scope/lib/index.js')

const pluginModule = await import(pathToFileURL(path.join(here, '..', 'lib', 'index.js')).href)
const plugin = pluginModule.default ?? pluginModule

const FIXTURE = path.join(here, 'fixtures', 'echo-server.mjs')
const SINGLE = path.join(here, 'fixtures', 'single-server.mjs')
const FIXTURE_TOOLS = [
  'mcp__fixture__add',
  'mcp__fixture__add_tool',
  'mcp__fixture__echo',
  'mcp__fixture__fail',
  'mcp__fixture__structured',
]
const FORCED_TOOLS = [
  'mcp__forced__add',
  'mcp__forced__add_tool',
  'mcp__forced__echo',
  'mcp__forced__fail',
  'mcp__forced__structured',
]
const HINT = "Call to load this MCP server's tools; call again to hide them."

const ctx = new Context()
ctx.plugin(SystemPrompt)
ctx.plugin(ToolRuntime, {})

/** Poll until `predicate` holds; Cordis activates plugins asynchronously. */
async function waitFor(predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

await waitFor(() => ctx.tools !== undefined, 'the tools service to come up')
ctx.plugin(plugin, {
  servers: {
    fixture: {
      description: 'Echo fixture server used by the e2e test',
      command: process.execPath,
      args: [FIXTURE],
    },
    solo: {
      description: 'Single-tool fixture server',
      command: process.execPath,
      args: [SINGLE],
    },
    forced: {
      description: 'Multi-tool server forced eager',
      mode: 'eager',
      command: process.execPath,
      args: [FIXTURE],
    },
    solo_lazy: {
      description: 'Single-tool server forced lazy',
      mode: 'lazy',
      command: process.execPath,
      args: [SINGLE],
    },
    toggle: {
      description: 'Toggle fixture server',
      mode: 'lazy',
      command: process.execPath,
      args: [SINGLE],
    },
    masked: {
      description: 'Masked fixture server',
      mode: 'lazy',
      hiddenTools: ['ping'],
      command: process.execPath,
      args: [SINGLE],
    },
    renamed: {
      description: 'Description-override fixture server',
      mode: 'lazy',
      toolDescriptions: { echo: 'Overridden echo description.' },
      maxParameterDescriptionChars: 20,
      command: process.execPath,
      args: [FIXTURE],
    },
  },
})

const signal = new AbortController().signal
let callSeq = 0
const call = (name, args, agent) =>
  ctx.tools.execute({ callId: `test-${++callSeq}`, name, arguments: args, agent, signal })
const textOf = (result) =>
  (result.content ?? [])
    .map((block) => (typeof block?.text === 'string' ? block.text : `[${block?.type ?? 'block'}]`))
    .join('\n')
const visible = (scope) => ctx.tools.schemas(scope).map((schema) => schema.name).sort()
const descriptionOf = (name) => ctx.tools.schemas().find((schema) => schema.name === name)?.description

// Converge the startup probe: `solo` loses its loader, `forced` gains its tools.
await waitFor(
  () => visible().includes('mcp__solo__ping') && visible().includes('mcp__forced__echo') && visible().includes('mcp_fixture'),
  'the startup probe to classify every server',
)

const results = []
async function check(id, title, fn) {
  try {
    await fn()
    results.push({ id, title, status: 'PASS', detail: '' })
  } catch (error) {
    results.push({ id, title, status: 'FAIL', detail: error instanceof Error ? error.message : String(error) })
  }
}

await check(1, 'a multi-tool server is hidden behind its loader', async () => {
  const names = visible()
  assert.ok(names.includes('mcp_fixture'), `loader missing: ${JSON.stringify(names)}`)
  for (const name of FIXTURE_TOOLS) assert.ok(!names.includes(name), `${name} leaked into the tool list`)
})

await check(2, 'the loader description is the server description plus the hint', async () => {
  assert.equal(descriptionOf('mcp_fixture'), `Echo fixture server used by the e2e test. ${HINT}`)
})

await check(3, 'a single-tool server is registered eagerly without a loader', async () => {
  const names = visible()
  assert.ok(names.includes('mcp__solo__ping'), `eager tool missing: ${JSON.stringify(names)}`)
  assert.ok(!names.includes('mcp_solo'), 'a loader was created for a single-tool server')
})

await check(4, 'the eagerly registered tool is callable', async () => {
  const result = await call('mcp__solo__ping', {})
  assert.equal(result.isError, false, textOf(result))
  assert.equal(textOf(result), 'pong')
})

await check(5, 'calling the loader returns ok and reveals the tools', async () => {
  const result = await call('mcp_fixture', {})
  assert.equal(result.isError, false, textOf(result))
  assert.equal(textOf(result), 'ok')
  const names = visible()
  for (const name of FIXTURE_TOOLS) assert.ok(names.includes(name), `${name} missing after load`)
})

await check(6, 'a revealed tool is really callable through the registry', async () => {
  const result = await call('mcp__fixture__echo', { text: 'hi' })
  assert.equal(result.isError, false, textOf(result))
  assert.equal(textOf(result), 'echo:hi')
})

await check(7, 'typed arguments reach the MCP server', async () => {
  const result = await call('mcp__fixture__add', { a: 2, b: 3 })
  assert.equal(result.isError, false, textOf(result))
  assert.equal(textOf(result), '5')
})

await check(8, 'an MCP tool error settles as an error result', async () => {
  const result = await call('mcp__fixture__fail', {})
  assert.equal(result.isError, true)
  assert.match(textOf(result), /fixture failure/)
})

await check(9, 'list_changed re-syncs the loaded generation', async () => {
  const result = await call('mcp__fixture__add_tool', {})
  assert.equal(result.isError, false, textOf(result))
  await waitFor(() => visible().includes('mcp__fixture__new_tool'), 'the re-synced generation')
  const created = await call('mcp__fixture__new_tool', {})
  assert.equal(created.isError, false, textOf(created))
  assert.equal(textOf(created), 'new_tool ok')
})

await check(10, 'the loader toggles: a second call hides, a third reveals', async () => {
  const hidden = await call('mcp_fixture', {})
  assert.match(textOf(hidden), /^ok \(\d+ tool\(s\) hidden\)$/)
  assert.ok(!visible().includes('mcp__fixture__echo'), 'tools stayed visible after the toggle')
  const shown = await call('mcp_fixture', {})
  assert.equal(textOf(shown), 'ok')
  assert.ok(visible().includes('mcp__fixture__echo'), 'tools missing after re-loading')
})

await check(11, 'an agent-scope restrict() still hides a revealed tool', async () => {
  // Mirrors inkstone-tool-hide: a per-agent deny list only works against global
  // registrations, and restrict() rejects names that are not globally registered.
  const agentKey = { id: 'hide-agent' }
  let scope
  ctx.plugin({
    name: 'test-scope-mint',
    inject: ['tools'],
    apply(mintCtx) {
      scope = createScope(mintCtx, agentKey)
    },
  })
  await waitFor(() => scope !== undefined, 'the test agent scope')
  try {
    assert.ok(visible(agentKey).includes('mcp__fixture__echo'), 'precondition: visible in the scope')
    scope.ctx.tools.restrict({ deny: ['mcp__fixture__echo'] })
    assert.ok(!visible(agentKey).includes('mcp__fixture__echo'), 'the deny did not hide the tool')
    assert.ok(visible().includes('mcp__fixture__echo'), 'the deployment view must keep the tool')
  } finally {
    await scope.dispose()
  }
})

await check(12, 'the assembled model request gains the tool after the loader call', async () => {
  // `solo_lazy` has never been loaded, so its tool must be absent from the
  // request; `fixture` was loaded in check 5, so its tools must be present.
  const assembly = await ctx.systemPrompt.assemble()
  const names = assembly.tools.map((tool) => tool.name)
  assert.ok(names.includes('mcp__fixture__echo'), `fixture tool missing from the request: ${names.join(',')}`)
  assert.ok(!names.includes('mcp__solo_lazy__ping'), 'a never-loaded server leaked into the request')
  assert.ok(names.includes('mcp_solo_lazy'), 'the lazy loader itself is missing from the request')
})

await check(13, 'mode: eager skips the loader and registers at startup', async () => {
  const names = visible()
  for (const name of FORCED_TOOLS) assert.ok(names.includes(name), `${name} missing for an eager server`)
  assert.ok(!names.includes('mcp_forced'), 'an eager server still got a loader')
})

await check(14, 'mode: lazy hides a single-tool server behind a loader', async () => {
  const names = visible()
  assert.ok(names.includes('mcp_solo_lazy'), 'loader missing for a lazy server')
  assert.ok(!names.includes('mcp__solo_lazy__ping'), 'lazy server tool leaked before its loader was called')
  const result = await call('mcp_solo_lazy', {})
  assert.equal(result.isError, false, textOf(result))
  assert.equal(textOf(result), 'ok')
  assert.ok(visible().includes('mcp__solo_lazy__ping'), 'tool missing after its loader was called')
})

await check(15, 'a tool whose structured content violates its own output schema still works', async () => {
  // Regression for a live inkstone failure: the SDK client validates
  // structuredContent against the tool's outputSchema and throws -32602 on extra
  // properties. The bridge must issue the raw request and skip that validator.
  const result = await call('mcp__fixture__structured', {})
  assert.equal(result.isError, false, textOf(result))
  assert.equal(textOf(result), 'structured ok')
})

await check(16, 'calling a loader again hides the tools it revealed', async () => {
  const first = await call('mcp_toggle', {})
  assert.equal(textOf(first), 'ok')
  assert.ok(visible().includes('mcp__toggle__ping'), 'tool missing after the first call')
  const second = await call('mcp_toggle', {})
  assert.match(textOf(second), /^ok \(\d+ tool\(s\) hidden\)$/)
  assert.ok(!visible().includes('mcp__toggle__ping'), 'tool still visible after the second call')
  const third = await call('mcp_toggle', {})
  assert.equal(textOf(third), 'ok')
  assert.ok(visible().includes('mcp__toggle__ping'), 'tool missing after the third call')
})

await check(17, 'hiddenTools masks a loaded server per agent', async () => {
  const agentKey = { id: 'masked-agent' }
  let scope
  ctx.plugin({
    name: 'test-mask-scope',
    inject: ['tools'],
    apply(mintCtx) {
      scope = createScope(mintCtx, agentKey)
    },
  })
  await waitFor(() => scope !== undefined, 'the mask test scope')
  try {
    const agent = { ctx: scope.ctx }
    const result = await call('mcp_masked', {}, agent)
    assert.equal(textOf(result), 'ok')
    assert.ok(visible().includes('mcp__masked__ping'), 'the tool must stay globally registered')
    assert.ok(
      !visible(agentKey).includes('mcp__masked__ping'),
      `hiddenTools did not mask the tool for the agent: ${JSON.stringify(visible(agentKey))}`,
    )
  } finally {
    await scope.dispose()
  }
})

await check(18, 'toolDescriptions and the parameter cap rewrite what the model sees', async () => {
  await call('mcp_renamed', {})
  const schema = ctx.tools.schemas().find((entry) => entry.name === 'mcp__renamed__echo')
  assert.ok(schema, 'the overridden tool is missing')
  assert.equal(schema.description, 'Overridden echo description.')
  const parameter = schema.parameters?.properties?.text?.description
  assert.ok(typeof parameter === 'string' && parameter.length <= 20, `not capped: ${String(parameter)}`)
  assert.ok(parameter.endsWith('…'), `not truncated: ${String(parameter)}`)
  const plain = ctx.tools.schemas().find((entry) => entry.name === 'mcp__renamed__add')
  assert.equal(plain.description, 'Add two numbers and return the sum as text.')
})

await check(19, 'an unknown description preset keeps the plugin unmounted', async () => {
  const isolated = new Context()
  isolated.plugin(SystemPrompt)
  isolated.plugin(ToolRuntime, {})
  await waitFor(() => isolated.tools !== undefined, 'the isolated tools service')
  isolated.plugin(plugin, {
    servers: { bad: { descriptionPreset: 'nope', command: process.execPath, args: [SINGLE] } },
  })
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.ok(
    !isolated.tools.schemas().some((entry) => entry.name === 'mcp_bad'),
    'a loader was registered despite the invalid preset',
  )
  await isolated.fiber.dispose()
})

const failures = results.filter((entry) => entry.status === 'FAIL')
for (const entry of results) {
  console.log(`${entry.status}  #${entry.id}  ${entry.title}${entry.detail ? `\n      ${entry.detail}` : ''}`)
}
console.log(`\n${results.length - failures.length}/${results.length} checks passed`)

// Tear the harness down so the plugin's cleanup closes the MCP subprocesses.
await ctx.fiber.dispose()
process.exit(failures.length === 0 ? 0 : 1)
