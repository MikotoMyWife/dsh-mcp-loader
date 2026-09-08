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
 * | 1 | mount with a 6-tool server                    | only its loader is visible, its real tools are hidden      |
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
 * | 13| mode: eager (6-tool server)                   | tools visible at mount, no loader                          |
 * | 14| mode: lazy (1-tool server)                    | loader present, tool hidden until the loader is called     |
 * | 15| tool whose structured content breaks its own output schema | still callable (live inkstone `search` regression) |
 * | 16| call the loader a second time                    | hides the tools; a third call reveals them again         |
 * | 17| hiddenTools masks a loaded server                 | masked for that agent, still global for everyone else    |
 * | 18| toolDescriptions + parameter cap                  | rewritten description and truncated parameter text       |
 * | 19| unknown descriptionPreset                         | plugin stays unmounted (fail fast)                       |
 * | 20| first connect crashes once (`flaky`)               | retried; load succeeds after exactly 2 child starts      |
 * | 21| a tool call crashes the server (`die`)             | error surfaced, call sent exactly once (never replayed); the next call reconnects to a fresh child |
 * | 22| `reconnectAttempts: 0` (`noretry`)                 | single attempt, v0.5.0 behavior: load fails, no tools    |
 * | 22b| invalid retry/idle config (negative / fractional)  | plugin stays unmounted, error names the field + server   |
 * | 23| `idleDisconnectMs: 300` (`idle`)                   | unload → connection closed (child exit marker) → reload rebuilds with a fresh child |
 * | 24| rebuild & visibility-transfer logs                 | `client rebuilt (attempt N)` and `loaded N tool(s)` lines observable via the logger exporter |
 * | 25| hiddenTools glob (`e*` / `mcp__s__*`)                 | matched tools denied per agent after load; other tools visible and callable |
 * | 26| exact-name rules (raw and `mcp__s__t`)                | deny exactly the named tool, as in v0.5.0 (#17 semantics unchanged) |
 * | 27| disabledTools (`suppressed`)                          | tool never registered: absent from assemble, unknown to execute, "loaded 0 tool(s)" log |
 * | 28| disabledTools all tools of an auto server (`dead`)    | probe disposes the loader; no tools; log names the disabledTools count |
 * | 29| lockout protection                                   | static loader-name rule keeps the plugin unmounted; a glob covering the loader warns once and never hides it |
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
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

// Per-run scratch dir for the fault-injection markers and observability logs;
// removed when the suite exits.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmcp-e2e-'))
const file = (name) => path.join(TMP, name)
const readLines = (name) => {
  try {
    return fs.readFileSync(file(name), 'utf8').split('\n').map((line) => line.trim()).filter(Boolean)
  } catch {
    return [] // not created yet
  }
}
const countLines = (name, line) => readLines(name).filter((entry) => entry === line).length
const waitForLines = (name, predicate, label, timeoutMs = 15_000) =>
  waitFor(() => predicate(readLines(name)), label, timeoutMs)

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

// Capture every log line of the shared context through Cordis' logger exporter
// so the new lifecycle logs (#24) are asserted on the real logging surface.
const logLines = []
ctx.logger.exporter({
  levels: { default: 99 },
  export(message) {
    for (const arg of message.args ?? []) {
      logLines.push(arg instanceof Error ? arg.message : String(arg))
    }
  },
})

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
    flaky: {
      description: 'Flaky fixture server whose first connection attempt crashes',
      mode: 'lazy',
      command: process.execPath,
      args: [FIXTURE],
      env: {
        ECHO_FAIL_FIRST_CONNECT: '1',
        ECHO_MARKER: file('flaky.marker'),
        ECHO_LOG: file('flaky.log'),
      },
    },
    noretry: {
      description: 'Fixture server with reconnect disabled (v0.5.0 semantics)',
      mode: 'lazy',
      reconnectAttempts: 0,
      command: process.execPath,
      args: [FIXTURE],
      env: {
        ECHO_FAIL_FIRST_CONNECT: '1',
        ECHO_MARKER: file('noretry.marker'),
        ECHO_LOG: file('noretry.log'),
      },
    },
    idle: {
      description: 'Idle-disconnect fixture server',
      mode: 'lazy',
      idleDisconnectMs: 300,
      command: process.execPath,
      args: [SINGLE],
      env: {
        ECHO_LOG: file('idle.log'),
        ECHO_EXIT_MARKER: file('idle.closed'),
      },
    },
    globbed: {
      description: 'Server hiding every tool matching a raw glob',
      mode: 'lazy',
      hiddenTools: ['e*'],
      command: process.execPath,
      args: [FIXTURE],
    },
    globfull: {
      description: 'Server hiding every tool matching a public-name glob',
      mode: 'lazy',
      hiddenTools: ['mcp__globfull__*'],
      command: process.execPath,
      args: [FIXTURE],
    },
    exactfull: {
      description: 'Server hiding one tool by its exact public name',
      mode: 'lazy',
      hiddenTools: ['mcp__exactfull__add'],
      command: process.execPath,
      args: [FIXTURE],
    },
    suppressed: {
      description: 'Single-tool server whose only tool is disabled',
      mode: 'lazy',
      disabledTools: ['ping'],
      command: process.execPath,
      args: [SINGLE],
    },
    dead: {
      description: 'Auto-classified single-tool server whose only tool is disabled',
      mode: 'auto',
      disabledTools: ['ping'],
      command: process.execPath,
      args: [SINGLE],
    },
    lockwild: {
      description: 'Server whose hiddenTools glob also covers its own loader name',
      mode: 'lazy',
      hiddenTools: ['ping', 'mcp_lockwild*'],
      command: process.execPath,
      args: [SINGLE],
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

await check(20, 'a first-connect crash is retried with backoff and the load succeeds', async () => {
  // `flaky` runs the echo fixture whose very first child process exits on
  // arrival (see ECHO_FAIL_FIRST_CONNECT); the default reconnectAttempts: 1
  // must spawn a second, healthy child and complete the load.
  const result = await call('mcp_flaky', {})
  assert.equal(result.isError, false, textOf(result))
  assert.ok(visible().includes('mcp__flaky__echo'), 'flaky tools missing after the retried load')
  // Exactly two child processes served this load: the injected crash + the retry.
  assert.equal(countLines('flaky.log', 'start'), 2, `unexpected starts: ${JSON.stringify(readLines('flaky.log'))}`)
})

await check(21, 'a mid-call crash surfaces once, is never replayed, and the next call reconnects', async () => {
  // `die` makes the fixture process exit mid-request. The call must come back
  // as an error and must have reached the server exactly once.
  const crashed = await call('mcp__flaky__die', {})
  assert.equal(crashed.isError, true, textOf(crashed))
  assert.equal(countLines('flaky.log', 'die'), 1, 'the crashed call must not be replayed')
  // The very next call auto-reconnects to a fresh child and succeeds.
  const again = await call('mcp__flaky__echo', { text: 'again' })
  assert.equal(again.isError, false, textOf(again))
  assert.equal(textOf(again), 'echo:again')
  await waitForLines(
    'flaky.log',
    (lines) => lines.filter((entry) => entry === 'start').length === 3,
    'the reconnect to spawn a fresh child process',
  )
})

await check(22, 'reconnectAttempts: 0 keeps the v0.5.0 single-attempt behavior', async () => {
  // `noretry` has the same crash-on-first-connect fixture but attempts=0: no
  // retry, the load fails, and only the crashed child is ever spawned.
  const result = await call('mcp_noretry', {})
  assert.equal(result.isError, true, textOf(result))
  assert.match(textOf(result), /could not connect to MCP server "noretry"/)
  assert.ok(!visible().includes('mcp__noretry__echo'), 'tools were registered despite the failed load')
  assert.equal(countLines('noretry.log', 'start'), 1, 'attempts=0 must not respawn the server')
})

await check('22b', 'an invalid retry/idle config keeps the plugin unmounted and names the field', async () => {
  const expectUnmounted = async (serverName, serverConfig, needle) => {
    const isolated = new Context()
    isolated.plugin(SystemPrompt)
    isolated.plugin(ToolRuntime, {})
    await waitFor(() => isolated.tools !== undefined, 'the isolated tools service')
    const lines = []
    isolated.logger.exporter({
      levels: { default: 99 },
      export(message) {
        for (const arg of message.args ?? []) {
          lines.push(arg instanceof Error ? arg.message : String(arg))
        }
      },
    })
    isolated.plugin(plugin, { servers: { [serverName]: serverConfig } })
    await waitFor(() => lines.some((line) => line.includes(needle) && line.includes(`"${serverName}"`)),
      `the mount error naming ${needle}`)
    assert.ok(
      !isolated.tools.schemas().some((entry) => entry.name.startsWith('mcp_')),
      `a loader was registered despite ${needle}`,
    )
    await isolated.fiber.dispose()
  }
  // Negative attempt count.
  await expectUnmounted(
    'badneg',
    { reconnectAttempts: -1, command: process.execPath, args: [SINGLE] },
    '"reconnectAttempts" must be a non-negative integer',
  )
  // Fractional idle timeout.
  await expectUnmounted(
    'badfrac',
    { idleDisconnectMs: 0.5, command: process.execPath, args: [SINGLE] },
    '"idleDisconnectMs" must be a non-negative integer',
  )
})

await check(23, 'idleDisconnectMs closes an unloaded connection; a later load rebuilds it', async () => {
  const first = await call('mcp_idle', {})
  assert.equal(textOf(first), 'ok')
  assert.ok(visible().includes('mcp__idle__ping'), 'ping missing after the load')
  const hidden = await call('mcp_idle', {})
  assert.match(textOf(hidden), /^ok \(\d+ tool\(s\) hidden\)$/)
  assert.ok(!visible().includes('mcp__idle__ping'), 'ping still visible after the unload')
  // The idle timer must close the (still warm) connection: the child exits and
  // writes its exit marker — proving unload itself did not close it (otherwise
  // the marker would already exist) and the idle disconnect did.
  assert.equal(countLines('idle.closed', 'closed'), 0, 'unload must not close the connection')
  await waitForLines('idle.closed', (lines) => lines.includes('closed'), 'the idle-disconnected child to exit')
  // Reload rebuilds the connection with a fresh child and the tool works.
  const again = await call('mcp_idle', {})
  assert.equal(textOf(again), 'ok')
  assert.ok(visible().includes('mcp__idle__ping'), 'ping missing after the rebuild')
  const pong = await call('mcp__idle__ping', {})
  assert.equal(pong.isError, false, textOf(pong))
  assert.equal(textOf(pong), 'pong')
  assert.equal(countLines('idle.log', 'start'), 2, 'the rebuild must spawn a fresh child process')
})

await check(24, 'rebuilds and visibility transfers are logged with counts (never silent)', async () => {
  // The checks above produce deterministic lifecycle lines on this shared
  // context; assert they are observable through the Cordis logger exporter:
  //   - #20: first-connect crash recovered on attempt 2 of "flaky";
  //   - #21: post-crash reconnect on attempt 1 of "flaky";
  //   - #20 load: a counted "loaded N tool(s) from \"flaky\"" line;
  //   - #23: idle disconnect event + rebuilt connection of "idle".
  const rebuilt = logLines.filter((line) => line.includes('client rebuilt'))
  assert.ok(
    rebuilt.some((line) => line.includes('"flaky"') && line.includes('(attempt 2)')),
    `missing the attempt-2 rebuild log: ${JSON.stringify(rebuilt)}`,
  )
  assert.ok(
    rebuilt.some((line) => line.includes('"flaky"') && line.includes('(attempt 1)')),
    `missing the attempt-1 rebuild log: ${JSON.stringify(rebuilt)}`,
  )
  assert.ok(
    logLines.some((line) => /loaded \d+ tool\(s\) from "flaky"/.test(line)),
    `missing the counted load log: ${JSON.stringify(logLines.slice(-20))}`,
  )
  assert.ok(
    logLines.some((line) => line.includes('"idle" disconnected after idle')),
    'missing the counted idle-disconnect log',
  )
})

await check(25, 'hiddenTools globs deny matched tools per agent and leave others callable', async () => {
  // `globbed` (raw glob `e*`) hides only `echo`; `globfull` (public glob
  // `mcp__globfull__*`) hides every tool of that server. Both masks are per
  // agent, mirroring the #17 scope pattern.
  const agentKey = { id: 'glob-scope' }
  let scope
  ctx.plugin({
    name: 'test-glob-scope',
    inject: ['tools'],
    apply(mintCtx) {
      scope = createScope(mintCtx, agentKey)
    },
  })
  await waitFor(() => scope !== undefined, 'the glob test scope')
  try {
    const agent = { ctx: scope.ctx }
    const raw = await call('mcp_globbed', {}, agent)
    assert.equal(textOf(raw), 'ok')
    const full = await call('mcp_globfull', {}, agent)
    assert.equal(textOf(full), 'ok')
    assert.ok(visible().includes('mcp__globbed__echo'), 'echo must stay globally registered')
    assert.ok(visible().includes('mcp__globfull__add'), 'globfull tools must stay globally registered')
    const scoped = visible(agentKey)
    assert.ok(!scoped.includes('mcp__globbed__echo'), `raw glob did not deny echo: ${JSON.stringify(scoped)}`)
    assert.ok(scoped.includes('mcp__globbed__add'), 'raw glob denied a non-matching tool')
    for (const tool of ['add', 'echo', 'fail', 'structured']) {
      assert.ok(!scoped.includes(`mcp__globfull__${tool}`), `public glob leaked ${tool} to the agent`)
    }
    assert.ok(scoped.includes('mcp_globfull'), 'the loader itself must stay visible to the agent')
    // The raw-glob non-match stays callable through the real registry.
    const added = await call('mcp__globbed__add', { a: 2, b: 3 })
    assert.equal(added.isError, false, textOf(added))
    assert.equal(textOf(added), '5')
  } finally {
    await scope.dispose()
  }
})

await check(26, 'exact hiddenTools names deny exactly the named tool (v0.5.0 semantics)', async () => {
  // `exactfull` uses the public exact name `mcp__exactfull__add`: deny is that
  // precise set — `echo` must stay visible and callable for the same agent
  // (raw exact names are the #17 `masked` regression, still green above).
  const agentKey = { id: 'exact-scope' }
  let scope
  ctx.plugin({
    name: 'test-exact-scope',
    inject: ['tools'],
    apply(mintCtx) {
      scope = createScope(mintCtx, agentKey)
    },
  })
  await waitFor(() => scope !== undefined, 'the exact test scope')
  try {
    const agent = { ctx: scope.ctx }
    const result = await call('mcp_exactfull', {}, agent)
    assert.equal(textOf(result), 'ok')
    assert.ok(visible().includes('mcp__exactfull__add'), 'the named tool must stay globally registered')
    const scoped = visible(agentKey)
    assert.ok(!scoped.includes('mcp__exactfull__add'), `exact full name leaked: ${JSON.stringify(scoped)}`)
    assert.ok(scoped.includes('mcp__exactfull__echo'), 'exact rule denied a tool it did not name')
    const echoed = await call('mcp__exactfull__echo', { text: 'hi' })
    assert.equal(echoed.isError, false, textOf(echoed))
    assert.equal(textOf(echoed), 'echo:hi')
  } finally {
    await scope.dispose()
  }
})

await check(27, 'disabledTools keeps the tool out of the registry entirely', async () => {
  // `suppressed` is a lazy single-tool server whose only tool is disabled:
  // loading it registers nothing.
  const result = await call('mcp_suppressed', {})
  assert.equal(result.isError, false, textOf(result))
  assert.ok(!visible().includes('mcp__suppressed__ping'), 'a disabled tool was registered')
  const assembly = await ctx.systemPrompt.assemble()
  const names = assembly.tools.map((tool) => tool.name)
  assert.ok(!names.includes('mcp__suppressed__ping'), `disabled tool leaked into the request: ${names.join(',')}`)
  const missing = await call('mcp__suppressed__ping', {})
  assert.equal(missing.isError, true, 'a disabled tool must not be callable')
  assert.match(textOf(missing), /unknown tool/, `unexpected text: ${textOf(missing)}`)
  assert.ok(
    logLines.some((line) => line.includes('loaded 0 tool(s) from "suppressed"')),
    `missing the filtered load log: ${JSON.stringify(logLines.slice(-20))}`,
  )
})

await check(28, 'an auto server whose every tool is disabled ends up with no loader', async () => {
  // `dead` (auto, single tool, disabled): the startup probe must classify it
  // as exposing no usable tools, dispose its loader, and log the count.
  await waitFor(
    () => logLines.some((line) => line.includes('"dead"') && line.includes('suppressed by disabledTools')),
    'the dead-server probe log',
  )
  const names = visible()
  assert.ok(!names.includes('mcp_dead'), 'a loader was kept for a fully disabled auto server')
  assert.ok(!names.includes('mcp__dead__ping'), 'a tool of the fully disabled server was registered')
})

await check(29, 'a rule naming its own loader keeps the plugin unmounted or warns once', async () => {
  // Static lockout: `hiddenTools` equal to the loader name is rejected at
  // mount, in an isolated context so the shared one is untouched.
  const staticCtx = new Context()
  staticCtx.plugin(SystemPrompt)
  staticCtx.plugin(ToolRuntime, {})
  await waitFor(() => staticCtx.tools !== undefined, 'the isolated tools service')
  const staticLines = []
  staticCtx.logger.exporter({
    levels: { default: 99 },
    export(message) {
      for (const arg of message.args ?? []) {
        staticLines.push(arg instanceof Error ? arg.message : String(arg))
      }
    },
  })
  staticCtx.plugin(plugin, {
    servers: {
      lockbad: { hiddenTools: ['mcp_lockbad'], command: process.execPath, args: [SINGLE] },
    },
  })
  await waitFor(
    () => staticLines.some((line) => line.includes('"lockbad"') && line.includes('loader')),
    'the static lockout error',
  )
  assert.ok(
    !staticCtx.tools.schemas().some((entry) => entry.name.startsWith('mcp_')),
    'a loader was registered despite the loader-name rule',
  )
  await staticCtx.fiber.dispose()
  // Wildcard lockout: `lockwild` glob `mcp_lockwild*` covers its own loader
  // name `mcp_lockwild`. The loader must stay visible and the removal warned
  // once; the exact `ping` rule still denies the tool per agent.
  const agentKey = { id: 'lock-scope' }
  let scope
  ctx.plugin({
    name: 'test-lock-scope',
    inject: ['tools'],
    apply(mintCtx) {
      scope = createScope(mintCtx, agentKey)
    },
  })
  await waitFor(() => scope !== undefined, 'the lockout test scope')
  try {
    const agent = { ctx: scope.ctx }
    const result = await call('mcp_lockwild', {}, agent)
    assert.equal(textOf(result), 'ok')
    await waitFor(
      () => logLines.some((line) => line.includes('"lockwild"') && line.includes('loader') && line.includes('kept visible')),
      'the loader-name warn',
    )
    const scoped = visible(agentKey)
    assert.ok(scoped.includes('mcp_lockwild'), `the loader must stay visible: ${JSON.stringify(scoped)}`)
    assert.ok(!scoped.includes('mcp__lockwild__ping'), 'the tool rule stopped applying')
    const ping = await call('mcp__lockwild__ping', {})
    assert.equal(ping.isError, false, textOf(ping))
    assert.equal(textOf(ping), 'pong')
  } finally {
    await scope.dispose()
  }
})

const failures = results.filter((entry) => entry.status === 'FAIL')
for (const entry of results) {
  console.log(`${entry.status}  #${entry.id}  ${entry.title}${entry.detail ? `\n      ${entry.detail}` : ''}`)
}
console.log(`\n${results.length - failures.length}/${results.length} checks passed`)

// Tear the harness down so the plugin's cleanup closes the MCP subprocesses.
await ctx.fiber.dispose()
fs.rmSync(TMP, { recursive: true, force: true })
process.exit(failures.length === 0 ? 0 : 1)
