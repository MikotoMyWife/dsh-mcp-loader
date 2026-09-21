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
 * | 30| discovery caps (`pages`/`crowd`/`slow`)                 | load fails, error names pages/tools/timeout, loader kept, repeat loads stay failed |
 * | 31| invalid discovery-cap config                           | plugin stays unmounted, error names the field + server |
 * | 32| monotonic discovery generation (`resyncgen`)            | a late, older re-sync snapshot is discarded ("discarded a stale discovery"); the newest generation lands |
 * | 33| re-sync regression (`resync2`) + empty change + guard    | whole-generation replace stays live (#9 semantics); an empty change keeps the generation stable; duplicate register throws |
 * | 34| re-sync × hiddenTools masks (`resyncmask`)              | a tool first seen in a re-sync is masked for new agents, not re-masked for already-masked ones |
 * | 35| hiddenTools public-name glob partial hit (`pmask`)       | denies only the matched tool, others visible and callable |
 * | 36| disabledTools exact public name / glob spellings         | matched tools never registered, others callable, counts logged |
 * | 37| a load by one session (`scoped`)                         | no other session — existing or created later — sees the tools |
 * | 38| a second session opts in, the first opts out              | each session's own view is independent; the generation survives |
 * | 39| subagent / fork lineage                                  | a subagent of a holder inherits; a fork starts unexpanded    |
 * | 40| the last holder leaves                                   | the generation is released for everyone                      |
 * | 41| an eager server (no loader)                              | never masked: nothing could reveal it again                  |
 * | 42| re-sync under per-session masks (`sessresync`)            | a newly discovered name is masked for non-holders too        |
 * | 43| a transport whose close never confirms (`hangclose`)      | teardown is bounded by closeTimeoutMs, logs it, and reuse is refused rather than spawning a second child |
 * | 44| an invalid closeTimeoutMs                                 | the plugin stays unmounted and names the field               |
 * | 45| a real stdio child's environment (`envprobe`)             | credentials and DSH_* withheld; proxy variables, NODE_USE_ENV_PROXY, NPM_CONFIG_* and the configured env overlay reach it |
 * | 46| a second instance claiming one server name                | refused at mount by name; the first instance keeps working    |
 * | 47| a spec-invalid `tools/call` result (`odd`)                | still reaches the renderer: the result schema stays ours, the client library's spec validator is bypassed |
 * | 48| a server without the `tools` capability (`notools`)        | loads as an empty catalogue, logs it once, never asked to list |
 * | 49| a server that ships `instructions` (`instructionssrv`)     | instructions appear in the load result, attributed to their server |
 * | 50| instructions over `maxInstructionBytes`                    | the load fails naming the limit, the loader survives, no tools register |
 * | 51| a loaded server with resources (`res`) + the real runtime  | shared resource tools appear after the load, list/read reach the server, withdrawn on unload |
 * | 52| no resource runtime composed                               | the plugin loads as usual, no resource tools, one explanatory line |
 * | 53| an `auto` server whose handshake hangs (`hangboot`)        | mount registers the loader without waiting for the child; nothing is revealed |
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
const McpResources = (await load('dsh-mcp-resources/lib/index.js')).default
const { createScope } = await load('dsh-scope/lib/index.js')

const pluginModule = await import(pathToFileURL(path.join(here, '..', 'lib', 'index.js')).href)
const plugin = pluginModule.default ?? pluginModule

const FIXTURE = path.join(here, 'fixtures', 'echo-server.mjs')
const SINGLE = path.join(here, 'fixtures', 'single-server.mjs')
const PAGINATED = path.join(here, 'fixtures', 'paginated-server.mjs')
const ENV_SERVER = path.join(here, 'fixtures', 'env-server.mjs')
const ODD_RESULT = path.join(here, 'fixtures', 'odd-result-server.mjs')
const NO_TOOLS = path.join(here, 'fixtures', 'no-tools-server.mjs')
const INSTRUCTIONS = path.join(here, 'fixtures', 'instructions-server.mjs')
const RESOURCES_SERVER = path.join(here, 'fixtures', 'resources-server.mjs')
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
const HINT = "Call to load this MCP server's tools into this session; call again to hide them."

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
    pages: {
      description: 'Paginated fixture server whose discovery hits the page cap',
      mode: 'lazy',
      maxToolListPages: 2,
      command: process.execPath,
      args: [PAGINATED],
      env: {
        ECHO_PAGINATE: '1',
        ECHO_LOG: file('pages.log'),
      },
    },
    crowd: {
      description: 'Fixture server exposing more tools than the per-server cap',
      mode: 'lazy',
      maxToolsPerServer: 4,
      command: process.execPath,
      args: [FIXTURE],
      env: {
        ECHO_LOG: file('crowd.log'),
      },
    },
    slow: {
      description: 'Paginated fixture server whose discovery never answers in time',
      mode: 'lazy',
      discoveryTimeoutMs: 1500,
      command: process.execPath,
      args: [PAGINATED],
      env: {
        ECHO_PAGINATE: '1',
        ECHO_HANG_MS: '60000',
        ECHO_LOG: file('slow.log'),
        ECHO_EXIT_MARKER: file('slow.closed'),
      },
    },
    resync2: {
      description: 'Fixture server re-synced twice (regression of the baseline #9 semantics)',
      mode: 'lazy',
      command: process.execPath,
      args: [FIXTURE],
      env: {
        ECHO_LOG: file('resync2.log'),
      },
    },
    resyncgen: {
      description: 'Paginated fixture server that grows twice while a re-sync is in flight',
      mode: 'lazy',
      command: process.execPath,
      args: [PAGINATED],
      env: {
        // late_a at +400ms, late_b at +600ms (each sends list_changed); the
        // first re-sync's tools/list (request #2) is delayed 1400ms so the
        // second, newer re-sync always lands first and the older snapshot —
        // which finishes later — is discarded by the generation guard.
        ECHO_NOTIFY1_MS: '2000',
        ECHO_NOTIFY2_MS: '2500',
        ECHO_SLOW_LIST_INDEX: '2',
        ECHO_SLOW_LIST_MS: '1400',
        ECHO_LOG: file('resyncgen.log'),
      },
    },
    resyncmask: {
      description: 'Masked fixture server whose re-sync introduces a newly maskable tool',
      mode: 'lazy',
      hiddenTools: ['echo', 'new_tool'],
      command: process.execPath,
      args: [FIXTURE],
      env: {
        ECHO_LOG: file('resyncmask.log'),
      },
    },
    pmask: {
      description: 'Server hiding the echo tool through a partial public-name glob',
      mode: 'lazy',
      hiddenTools: ['mcp__pmask__e*'],
      command: process.execPath,
      args: [FIXTURE],
    },
    dsuppfull: {
      description: 'Server disabling one tool by its exact public name',
      mode: 'lazy',
      disabledTools: ['mcp__dsuppfull__add'],
      command: process.execPath,
      args: [FIXTURE],
    },
    dsuppglob: {
      description: 'Server disabling tools through raw and public-name globs',
      mode: 'lazy',
      disabledTools: ['f*', 'mcp__dsuppglob__s*'],
      command: process.execPath,
      args: [FIXTURE],
    },
    scoped: {
      description: 'Lazy multi-tool server used by the per-session visibility checks',
      mode: 'lazy',
      command: process.execPath,
      args: [FIXTURE],
      env: {
        ECHO_LOG: file('scoped.log'),
      },
    },
    sessresync: {
      description: 'Per-session server whose re-sync introduces a name the masks must learn',
      mode: 'lazy',
      command: process.execPath,
      args: [FIXTURE],
      env: {
        ECHO_LOG: file('sessresync.log'),
      },
    },
    scoped2: {
      description: 'Second lazy server for the mutual-isolation checks',
      mode: 'lazy',
      command: process.execPath,
      args: [FIXTURE],
      env: {
        ECHO_LOG: file('scoped2.log'),
      },
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

await check(30, 'discovery caps: pages/tools/timeout fail the load, name the reason, keep the loader', async () => {
  const expectCapFailure = async (serverName, reasonNeedle) => {
    const first = await call(`mcp_${serverName}`, {})
    assert.equal(first.isError, true, textOf(first))
    assert.match(textOf(first), reasonNeedle, `reason not named: ${textOf(first)}`)
    assert.ok(visible().includes(`mcp_${serverName}`), 'the loader must survive a discovery-cap failure')
    assert.ok(
      !visible().some((name) => name.startsWith(`mcp__${serverName}__`)),
      `tools were registered despite the ${serverName} cap`,
    )
    // A repeat load fails the same deterministic way: no half-loaded state.
    const again = await call(`mcp_${serverName}`, {})
    assert.equal(again.isError, true, textOf(again))
    assert.match(textOf(again), reasonNeedle, `reason not named on retry: ${textOf(again)}`)
    assert.ok(
      !visible().some((name) => name.startsWith(`mcp__${serverName}__`)),
      `tools were registered on the ${serverName} retry`,
    )
  }
  // Pages: the paginated fixture needs 3 pages (pageSize 2); capped at 2 the
  // discovery stops exactly after page 2 without requesting page 3, and keeps
  // the same child alive across attempts (the cap is not a transport failure).
  await expectCapFailure('pages', /page limit of 2 pages/)
  assert.equal(countLines('pages.log', 'list'), 4, 'expected 2 pages per attempt × 2 attempts')
  assert.equal(countLines('pages.log', 'start'), 1, 'the pages cap must not drop the healthy client')
  // Tools: the echo fixture exposes 6 raw tools; capped at 4 the discovery
  // stops after the page that overflows the cap.
  await expectCapFailure('crowd', /tool limit of 4 tools/)
  assert.equal(countLines('crowd.log', 'start'), 1, 'the tools cap must not drop the healthy client')
  // Timeout: every tools/list hangs 60s; the 1500ms discovery deadline fails
  // the load and drops the client (the hung child is closed — exit marker),
  // so a later load reconnects to a fresh child and fails again, consistently.
  const slowFirst = await call('mcp_slow', {})
  assert.equal(slowFirst.isError, true, textOf(slowFirst))
  assert.match(textOf(slowFirst), /discovery timeout of 1500ms/, `reason not named: ${textOf(slowFirst)}`)
  assert.ok(visible().includes('mcp_slow'), 'the loader must survive a discovery-timeout failure')
  await waitForLines('slow.closed', (lines) => lines.includes('closed'), 'the hung child to be closed by the discovery timeout')
  const slowAgain = await call('mcp_slow', {})
  assert.equal(slowAgain.isError, true, textOf(slowAgain))
  assert.match(textOf(slowAgain), /discovery timeout of 1500ms/, `reason not named on retry: ${textOf(slowAgain)}`)
  assert.ok(
    !visible().some((name) => name.startsWith('mcp__slow__')),
    'tools were registered despite the discovery timeout',
  )
  assert.equal(countLines('slow.log', 'start'), 2, 'each slow attempt must reconnect to a fresh child')
})

await check(31, 'an invalid discovery-cap config keeps the plugin unmounted and names the field', async () => {
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
    await waitFor(
      () => lines.some((line) => line.includes(needle) && line.includes(`"${serverName}"`)),
      `the mount error naming ${needle}`,
    )
    assert.ok(
      !isolated.tools.schemas().some((entry) => entry.name.startsWith('mcp_')),
      `a loader was registered despite ${needle}`,
    )
    await isolated.fiber.dispose()
  }
  await expectUnmounted(
    'badpages',
    { maxToolListPages: 0, command: process.execPath, args: [PAGINATED] },
    '"maxToolListPages" must be a positive integer',
  )
  await expectUnmounted(
    'badcap',
    { maxToolsPerServer: 2.5, command: process.execPath, args: [FIXTURE] },
    '"maxToolsPerServer" must be a positive integer',
  )
  await expectUnmounted(
    'badtimeout',
    { discoveryTimeoutMs: -1, command: process.execPath, args: [FIXTURE] },
    '"discoveryTimeoutMs" must be a positive integer',
  )
})

await check(32, 'a late, older re-sync snapshot is discarded; only the newest generation lands', async () => {
  // `resyncgen` grows its list at +400ms (`late_a`) and +600ms (`late_b`), each
  // emitting list_changed. The first re-sync's tools/list request is delayed
  // 1400ms, so the second (newer-versioned) re-sync always lands first and the
  // older snapshot — which necessarily completes later — is dropped by the
  // monotonic-generation landing check instead of overwriting the newer one.
  const first = await call('mcp_resyncgen', {})
  assert.equal(first.isError, false, textOf(first))
  for (const tool of ['add', 'add_tool', 'die', 'echo', 'fail', 'structured']) {
    assert.ok(visible().includes(`mcp__resyncgen__${tool}`), `base tool ${tool} missing after the load`)
  }
  await waitFor(
    () => visible().includes('mcp__resyncgen__late_a') && visible().includes('mcp__resyncgen__late_b'),
    'both growth re-syncs to land',
    10_000,
  )
  await waitFor(
    () =>
      logLines.some(
        (line) => line.includes('discarded a stale discovery') && line.includes('"resyncgen"'),
      ),
    'the stale-discovery discard log',
    10_000,
  )
  // Stability: once the newest generation landed and the stale one was
  // discarded, nothing may regress the generation afterwards.
  await new Promise((resolve) => setTimeout(resolve, 600))
  const names = visible()
  assert.ok(names.includes('mcp__resyncgen__late_a'), 'late_a missing from the final generation')
  assert.ok(names.includes('mcp__resyncgen__late_b'), 'late_b missing from the final generation')
  const only = names.filter((name) => name.startsWith('mcp__resyncgen__')).sort()
  assert.deepEqual(
    only,
    ['mcp__resyncgen__add', 'mcp__resyncgen__add_tool', 'mcp__resyncgen__die', 'mcp__resyncgen__echo',
      'mcp__resyncgen__fail', 'mcp__resyncgen__late_a', 'mcp__resyncgen__late_b', 'mcp__resyncgen__structured'],
    `unexpected final generation: ${JSON.stringify(only)}`,
  )
  const lateA = await call('mcp__resyncgen__late_a', {})
  assert.equal(lateA.isError, false, textOf(lateA))
  assert.equal(textOf(lateA), 'late_a ok')
  const lateB = await call('mcp__resyncgen__late_b', {})
  assert.equal(lateB.isError, false, textOf(lateB))
  assert.equal(textOf(lateB), 'late_b ok')
})

await check(33, 'a re-sync replaces the generation whole; an empty change leaves it stable', async () => {
  // Baseline of #9 on a dedicated server: load → add_tool → the new tool is
  // live and callable through the real registry.
  const load = await call('mcp_resync2', {})
  assert.equal(load.isError, false, textOf(load))
  const added = await call('mcp__resync2__add_tool', {})
  assert.equal(added.isError, false, textOf(added))
  await waitFor(() => visible().includes('mcp__resync2__new_tool'), 'the re-synced generation of resync2')
  const created = await call('mcp__resync2__new_tool', {})
  assert.equal(created.isError, false, textOf(created))
  assert.equal(textOf(created), 'new_tool ok')
  const before = visible().filter((name) => name.startsWith('mcp__resync2__')).sort()
  // An empty change (new_tool already present) still re-syncs: the whole
  // generation is replaced by identical content and stays live.
  const again = await call('mcp__resync2__add_tool', {})
  assert.equal(again.isError, false, textOf(again))
  await new Promise((resolve) => setTimeout(resolve, 600))
  const after = visible().filter((name) => name.startsWith('mcp__resync2__')).sort()
  assert.deepEqual(after, before, 'the empty change must not alter the generation')
  const created2 = await call('mcp__resync2__new_tool', {})
  assert.equal(created2.isError, false, textOf(created2))
  assert.equal(textOf(created2), 'new_tool ok')
  // Guard (slice 03 step 0): the re-sync ordering relies on duplicate-name
  // registration throwing — assert the installed registry still does, so a
  // future dsh upgrade that silently overwrites would fail this test loudly.
  const guardDefinition = {
    name: 'probe_dup_guard',
    description: 'duplicate-register guard probe',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object', properties: {} },
      render(_args, value) {
        return [{ type: 'text', text: 'guard' }]
      },
    },
  }
  let disposer
  try {
    disposer = ctx.tools.register(guardDefinition)
    assert.throws(
      () => ctx.tools.register({ ...guardDefinition }),
      /already registered/,
      'a duplicate global register must throw (never overwrite silently)',
    )
  } finally {
    disposer?.()
  }
})

await check(34, 'a tool first seen in a re-sync is masked for new agents, not for already-masked ones', async () => {
  // README claim: a deny mask is applied once per server per agent; a tool
  // that first appears in a later re-sync is masked for agents created after
  // that re-sync, but not for agents masked under the earlier expansion.
  const keyA = { id: 'maskgrow-a' }
  let scopeA
  ctx.plugin({
    name: 'test-maskgrow-a',
    inject: ['tools'],
    apply(mintCtx) {
      scopeA = createScope(mintCtx, keyA)
    },
  })
  await waitFor(() => scopeA !== undefined, 'the maskgrow agent A scope')
  const agentA = { ctx: scopeA.ctx }
  try {
    // Load via agent A: at this point only `echo` matches the rules, so A is
    // masked for echo — `new_tool` does not exist yet.
    const loaded = await call('mcp_resyncmask', {}, agentA)
    assert.equal(textOf(loaded), 'ok')
    assert.ok(!visible(keyA).includes('mcp__resyncmask__echo'), 'echo must be masked for the loader agent')
    // Grow: new_tool appears in a re-sync (the deny mask now covers it too).
    const added = await call('mcp__resyncmask__add_tool', {})
    assert.equal(added.isError, false, textOf(added))
    await waitFor(() => visible().includes('mcp__resyncmask__new_tool'), 'the resyncmask re-sync')
    // Agent A was masked before the re-sync and is not re-masked: new_tool is
    // visible to it, while its earlier mask persists.
    const scopedA = visible(keyA)
    assert.ok(!scopedA.includes('mcp__resyncmask__echo'), 'the earlier mask must persist for agent A')
    assert.ok(
      scopedA.includes('mcp__resyncmask__new_tool'),
      'a pre-existing agent must not be re-masked for a re-synced tool',
    )
    // Agent B created after the re-sync gets the refreshed deny set, which
    // includes new_tool (mirrors the agent/created path of the real harness).
    const keyB = { id: 'maskgrow-b' }
    let scopeB
    ctx.plugin({
      name: 'test-maskgrow-b',
      inject: ['tools'],
      apply(mintCtx) {
        scopeB = createScope(mintCtx, keyB)
      },
    })
    await waitFor(() => scopeB !== undefined, 'the maskgrow agent B scope')
    try {
      ctx.emit('agent/created', { agent: { ctx: scopeB.ctx } })
      await waitFor(
        () => !visible(keyB).includes('mcp__resyncmask__new_tool'),
        'agent B to be masked with the refreshed deny set',
      )
      const scopedB = visible(keyB)
      assert.ok(!scopedB.includes('mcp__resyncmask__echo'), 'agent B must carry the base mask')
      assert.ok(!scopedB.includes('mcp__resyncmask__new_tool'), 'agent B must be masked for the re-synced tool')
    } finally {
      await scopeB.dispose()
    }
    // The tools stay globally registered for everyone else.
    assert.ok(visible().includes('mcp__resyncmask__new_tool'), 'new_tool must stay globally registered')
  } finally {
    await scopeA.dispose()
  }
})

await check(35, 'a public-name glob that partially hits denies exactly the matched tool', async () => {
  // Slice-2 review leftover: hiddenTools spelled as a public-name glob that
  // only partially covers the server (`mcp__pmask__e*` matches only `echo` of
  // the six tools). The deny list must be exactly that one tool.
  const agentKey = { id: 'pmask-scope' }
  let scope
  ctx.plugin({
    name: 'test-pmask-scope',
    inject: ['tools'],
    apply(mintCtx) {
      scope = createScope(mintCtx, agentKey)
    },
  })
  await waitFor(() => scope !== undefined, 'the pmask test scope')
  try {
    const agent = { ctx: scope.ctx }
    const result = await call('mcp_pmask', {}, agent)
    assert.equal(textOf(result), 'ok')
    assert.ok(visible().includes('mcp__pmask__echo'), 'echo must stay globally registered')
    const scoped = visible(agentKey)
    assert.ok(!scoped.includes('mcp__pmask__echo'), `expected partial public glob to hide echo, but it stayed visible: ${JSON.stringify(scoped)}`)
    assert.ok(scoped.includes('mcp__pmask__add'), 'partial public glob denied a non-matching tool')
    const added = await call('mcp__pmask__add', { a: 2, b: 3 })
    assert.equal(added.isError, false, textOf(added))
    assert.equal(textOf(added), '5')
  } finally {
    await scope.dispose()
  }
})

await check(36, 'disabledTools exact public name and glob spellings never register matched tools', async () => {
  // Slice-2 review leftover: the disabledTools axis was only ever tested with
  // an exact raw name (#27/#28). Cover the exact public full name and both
  // glob spellings: the matched tools must never register, the rest stays
  // callable, and the loaded counts reflect the filtered set.
  const loadedPublic = await call('mcp_dsuppfull', {})
  assert.equal(loadedPublic.isError, false, textOf(loadedPublic))
  assert.ok(!visible().includes('mcp__dsuppfull__add'), 'a public exact-name disabled tool was registered')
  assert.ok(visible().includes('mcp__dsuppfull__echo'), 'the non-disabled tool is missing')
  const unknown1 = await call('mcp__dsuppfull__add', { a: 1, b: 2 })
  assert.equal(unknown1.isError, true, 'a public exact-name disabled tool must not be callable')
  assert.match(textOf(unknown1), /unknown tool/, `unexpected text: ${textOf(unknown1)}`)
  const echoed1 = await call('mcp__dsuppfull__echo', { text: 'hi' })
  assert.equal(echoed1.isError, false, textOf(echoed1))
  assert.equal(textOf(echoed1), 'echo:hi')
  assert.ok(
    logLines.some((line) => line.includes('loaded 5 tool(s) from "dsuppfull"')),
    `missing the dsuppfull filtered count: ${JSON.stringify(logLines.slice(-10))}`,
  )
  const loadedGlob = await call('mcp_dsuppglob', {})
  assert.equal(loadedGlob.isError, false, textOf(loadedGlob))
  // `f*` (raw glob) matches `fail`; `mcp__dsuppglob__s*` (public glob) matches
  // `structured`. The other four tools must stay registered and callable.
  for (const gone of ['fail', 'structured']) {
    assert.ok(!visible().includes(`mcp__dsuppglob__${gone}`), `a glob-disabled tool was registered: ${gone}`)
  }
  for (const kept of ['add', 'echo']) {
    assert.ok(visible().includes(`mcp__dsuppglob__${kept}`), `glob rules disabled too much: ${kept}`)
  }
  const unknown2 = await call('mcp__dsuppglob__fail', {})
  assert.equal(unknown2.isError, true, 'a glob-disabled tool must not be callable')
  assert.match(textOf(unknown2), /unknown tool/, `unexpected text: ${textOf(unknown2)}`)
  const echoed2 = await call('mcp__dsuppglob__echo', { text: 'yo' })
  assert.equal(echoed2.isError, false, textOf(echoed2))
  assert.equal(textOf(echoed2), 'echo:yo')
  assert.ok(
    logLines.some((line) => line.includes('loaded 4 tool(s) from "dsuppglob"')),
    `missing the dsuppglob filtered count: ${JSON.stringify(logLines.slice(-10))}`,
  )
})

// ── per-session visibility (slice 04) ────────────────────────────────────────

/**
 * Mint one agent the way the harness does: a real scope under a live plugin
 * context, announced on `agent/created` so the plugin reconciles that agent's
 * masks before its first request. `header` supplies the session identity the
 * plugin reads for its holder and lineage decisions.
 */
async function mintAgent(name, header = {}) {
  const key = { id: name }
  let scope
  ctx.plugin({
    name: `test-${name}`,
    inject: ['tools'],
    apply(mintCtx) {
      scope = createScope(mintCtx, key)
    },
  })
  await waitFor(() => scope !== undefined, `the ${name} agent scope`)
  const agent = { id: name, session: { header: { id: name, isSeeded: false, ...header } }, ctx: scope.ctx }
  ctx.emit('agent/created', { agent })
  return { key, scope, agent, dispose: () => scope.dispose() }
}

/** Tear one minted agent down the way the harness does, disposal event included. */
const disposeAgent = async (minted) => {
  ctx.emit('agent/disposed', { agent: minted.agent })
  await minted.scope.dispose()
}

await check(37, 'a load performed by one session expands no other session', async () => {
  const other = await mintAgent('sess-other')
  const holder = await mintAgent('sess-holder')
  try {
    assert.ok(
      !visible(other.key).includes('mcp__scoped__echo'),
      'precondition: the scoped server must not be loaded yet',
    )
    const result = await call('mcp_scoped', {}, holder.agent)
    assert.equal(textOf(result), 'ok')
    // Invariant 1 is untouched: the tools are still registered deployment-wide,
    // and only the per-agent mask keeps them out of another session's view.
    assert.ok(visible().includes('mcp__scoped__echo'), 'the tool must stay globally registered')
    assert.ok(
      visible(holder.key).includes('mcp__scoped__echo'),
      'the session that called the loader must see the tools it loaded',
    )
    assert.ok(
      !visible(other.key).includes('mcp__scoped__echo'),
      'a session that never called the loader inherited another session disclosure',
    )
    assert.ok(visible(other.key).includes('mcp_scoped'), 'the loader itself must stay visible to every session')
    // A session created after the load must start unexpanded too.
    const later = await mintAgent('sess-later')
    try {
      assert.ok(
        !visible(later.key).includes('mcp__scoped__echo'),
        'a session created after the load started out expanded',
      )
      assert.ok(visible(later.key).includes('mcp_scoped'), 'the loader must stay visible to a new session')
    } finally {
      await disposeAgent(later)
    }
  } finally {
    await disposeAgent(other)
    await disposeAgent(holder)
  }
})

await check(38, 'sessions toggle their own view without withdrawing another', async () => {
  const first = await mintAgent('sess-first')
  const second = await mintAgent('sess-second')
  try {
    await call('mcp_scoped2', {}, first.agent)
    assert.ok(visible(first.key).includes('mcp__scoped2__echo'), 'the first session must see its own load')
    assert.ok(!visible(second.key).includes('mcp__scoped2__echo'), 'the second session must start masked')
    // The masked session can opt in itself; the generation is already registered,
    // so this must not re-register or release anything.
    const optedIn = await call('mcp_scoped2', {}, second.agent)
    assert.equal(textOf(optedIn), 'ok')
    assert.ok(visible(second.key).includes('mcp__scoped2__echo'), 'the opting-in session must see the tools')
    assert.ok(visible(first.key).includes('mcp__scoped2__echo'), 'the first session must be unaffected')
    // One session hiding its own view must not withdraw the other's.
    const hidden = await call('mcp_scoped2', {}, first.agent)
    assert.match(textOf(hidden), /tool\(s\) hidden/, `unexpected text: ${textOf(hidden)}`)
    assert.ok(!visible(first.key).includes('mcp__scoped2__echo'), 'the toggling session must be masked again')
    assert.ok(visible(second.key).includes('mcp__scoped2__echo'), 'another session lost tools it was still holding')
    assert.ok(visible().includes('mcp__scoped2__echo'), 'the generation must survive while one holder remains')
  } finally {
    await disposeAgent(first)
    await disposeAgent(second)
  }
})

await check(39, 'a subagent of a holder inherits; a fork does not', async () => {
  const holder = await mintAgent('lineage-holder')
  try {
    await call('mcp_scoped', {}, holder.agent)
    assert.ok(visible(holder.key).includes('mcp__scoped__echo'), 'the holder must see its own load')
    // A subagent is created through its parent's context: it inherits the
    // disclosure without calling the loader itself.
    const child = await mintAgent('lineage-child', {
      origin: 'subagent',
      parentSession: 'lineage-holder',
      delegationDepth: 1,
    })
    try {
      assert.ok(
        visible(child.key).includes('mcp__scoped__echo'),
        'a subagent of a holding session must inherit the loaded tools',
      )
    } finally {
      await disposeAgent(child)
    }
    // A fork carries `parentSession` as seed lineage and no `origin`: it is a new
    // session and must start unexpanded.
    const fork = await mintAgent('lineage-fork', { parentSession: 'lineage-holder', isSeeded: true })
    try {
      assert.ok(
        !visible(fork.key).includes('mcp__scoped__echo'),
        'a forked session must not inherit another session disclosure',
      )
    } finally {
      await disposeAgent(fork)
    }
  } finally {
    await disposeAgent(holder)
  }
})

await check(40, 'the last holder leaving releases the generation for everyone', async () => {
  const holder = await mintAgent('release-holder')
  await call('mcp_scoped', {}, holder.agent)
  assert.ok(visible().includes('mcp__scoped__echo'), 'precondition: the server must be loaded')
  // Disposing the only holder withdraws the disclosure everywhere, because a
  // generation nobody holds would be visible to no session anyway.
  await disposeAgent(holder)
  await waitFor(() => !visible().includes('mcp__scoped__echo'), 'the released generation')
  assert.ok(!visible().includes('mcp__scoped__die'), 'no tool of the released server may survive')
})

await check(41, 'an eager server with no loader is never masked', async () => {
  // `forced` is mode: eager, so its loader was disposed at startup. Masking it
  // would hide tools no session could reveal again.
  const agent = await mintAgent('eager-agent')
  try {
    assert.ok(
      visible(agent.key).includes('mcp__forced__echo'),
      'an eager server must stay visible to every session',
    )
    const called = await call('mcp__forced__add', { a: 1, b: 2 }, agent.agent)
    assert.equal(called.isError, false, textOf(called))
    assert.equal(textOf(called), '3')
  } finally {
    await disposeAgent(agent)
  }
})

await check(42, 'a re-sync extends the per-session mask to newly discovered names', async () => {
  const holder = await mintAgent('resync-holder')
  const other = await mintAgent('resync-other')
  try {
    await call('mcp_sessresync', {}, holder.agent)
    assert.ok(visible(holder.key).includes('mcp__sessresync__echo'), 'the holder must see the first generation')
    assert.ok(!visible(other.key).includes('mcp__sessresync__echo'), 'the other session must be masked')
    assert.ok(!visible().includes('mcp__sessresync__new_tool'), 'precondition: new_tool does not exist yet')
    // Grow the server: `new_tool` only ever exists after the re-sync, so a mask
    // computed once at load time would miss it.
    const added = await call('mcp__sessresync__add_tool', {})
    assert.equal(added.isError, false, textOf(added))
    await waitFor(() => visible().includes('mcp__sessresync__new_tool'), 'the sessresync re-sync')
    assert.ok(
      visible(holder.key).includes('mcp__sessresync__new_tool'),
      'the holder must see the re-synced tool',
    )
    assert.ok(
      !visible(other.key).includes('mcp__sessresync__new_tool'),
      'a re-synced tool leaked past the per-session mask',
    )
  } finally {
    await disposeAgent(holder)
    await disposeAgent(other)
  }
})

await check(43, 'a close that cannot be confirmed poisons the connection instead of hanging teardown', async () => {
  const { ServerConnection } = await import(pathToFileURL(path.join(here, '..', 'lib', 'connection.js')).href)
  const lines = []
  const logger = {
    info: (message) => lines.push(message),
    warn: (message) => lines.push(message),
    error: (message) => lines.push(message),
  }
  // A transport whose close() never settles cannot be built from a real stdio
  // child on Windows (Node terminates it outright), so the barrier is exercised
  // through the documented transport seam with a synthetic one.
  const hangingTransport = {
    async start() {
      throw new Error('synthetic start failure')
    },
    async send() {
      throw new Error('unused')
    },
    async close() {
      return new Promise(() => {})
    },
  }
  const withDeadline = (promise, ms, label) =>
    Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms)),
    ])
  const connection = new ServerConnection(
    'hangclose',
    { command: process.execPath, closeTimeoutMs: 120, reconnectAttempts: 0 },
    logger,
    { connectTimeoutMs: 200, transportFactory: () => hangingTransport },
  )
  const started = Date.now()
  await assert.rejects(
    () => withDeadline(connection.listTools(), 2_000, 'the failed connect'),
    /could not connect to MCP server "hangclose"/,
  )
  const elapsed = Date.now() - started
  assert.ok(elapsed < 3_000, `teardown must be bounded by closeTimeoutMs, but took ${elapsed}ms`)
  assert.ok(
    lines.some((line) => line.includes('transport closure could not be confirmed')),
    'the unconfirmed closure must be logged, not swallowed',
  )
  // The child may still be alive: reuse must refuse rather than spawn a second one.
  await assert.rejects(
    () => withDeadline(connection.listTools(), 2_000, 'the refused reuse'),
    (error) => error?.name === 'UnconfirmedCloseError' && /overlapping server processes/.test(error.message),
  )
  const teardown = Date.now()
  await connection.close()
  assert.ok(Date.now() - teardown < 500, 'close() on a poisoned connection must return at once')
})

await check(44, 'an invalid closeTimeoutMs keeps the plugin unmounted and names the field', async () => {
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
    await waitFor(
      () => lines.some((line) => line.includes(needle) && line.includes(`"${serverName}"`)),
      `the mount error naming ${needle}`,
    )
    assert.ok(
      !isolated.tools.schemas().some((entry) => entry.name.startsWith('mcp_')),
      `a loader was registered despite ${needle}`,
    )
    await isolated.fiber.dispose()
  }
  await expectUnmounted(
    'badclose',
    { closeTimeoutMs: 0, command: process.execPath, args: [FIXTURE] },
    '"closeTimeoutMs" must be a positive integer',
  )
  await expectUnmounted(
    'badclose2',
    { closeTimeoutMs: 1.5, command: process.execPath, args: [FIXTURE] },
    '"closeTimeoutMs" must be a positive integer',
  )
})

await check(45, 'the stdio child gets a scrubbed but complete environment', async () => {
  const secrets = {
    MCP_FAKE_TOKEN: 'token-should-never-leak',
    MCP_FAKE_PASSWORD: 'password-should-never-leak',
    MCP_FAKE_KEY: 'key-should-never-leak',
    DSH_FAKE_FACT: 'dsh-fact-should-never-leak',
  }
  const passthrough = {
    HTTPS_PROXY: 'http://proxy.example:8080',
    NPM_CONFIG_REGISTRY: 'https://registry.example/',
  }
  Object.assign(process.env, secrets, passthrough)
  const isolated = new Context()
  isolated.plugin(SystemPrompt)
  isolated.plugin(ToolRuntime, {})
  await waitFor(() => isolated.tools !== undefined, 'the isolated tools service')
  isolated.plugin(plugin, {
    servers: {
      envprobe: {
        description: 'Environment probe',
        mode: 'lazy',
        command: process.execPath,
        args: [ENV_SERVER],
        env: { MCP_EXTRA: 'from-config' },
      },
    },
  })
  try {
    await waitFor(() => isolated.tools.schemas().some((entry) => entry.name === 'mcp_envprobe'), 'the env loader')
    const loaded = await isolated.tools.execute({ callId: 'env-load', name: 'mcp_envprobe', arguments: {}, signal })
    assert.equal(loaded.isError, false, 'the env server must load')
    const result = await isolated.tools.execute({
      callId: 'env-report',
      name: 'mcp__envprobe__env_report',
      arguments: {},
      signal,
    })
    const report = Object.fromEntries(
      (result.content ?? [])
        .map((block) => (typeof block?.text === 'string' ? block.text : ''))
        .join('\n')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const at = line.indexOf('=')
          return [line.slice(0, at), line.slice(at + 1)]
        }),
    )
    for (const [key, value] of Object.entries(secrets)) {
      assert.equal(report[key], '(absent)', `${key} leaked into the MCP child (${value})`)
    }
    for (const [key, value] of Object.entries(passthrough)) {
      assert.equal(report[key], value, `${key} must reach the child, which npx-based servers route through`)
    }
    assert.equal(report.NODE_USE_ENV_PROXY, '1', 'a child Node needs the flag to honor the inherited proxy')
    assert.equal(report.MCP_EXTRA, 'from-config', 'the configured env overlay must win')
    assert.notEqual(report.PATH, '(absent)', 'PATH must survive the scrub or npx cannot resolve')
  } finally {
    for (const key of [...Object.keys(secrets), ...Object.keys(passthrough)]) delete process.env[key]
    await isolated.fiber.dispose()
  }
})

await check(46, 'a second instance claiming the same server name fails at mount and names it', async () => {
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
  const config = { servers: { duplicate: { mode: 'lazy', command: process.execPath, args: [SINGLE] } } }
  isolated.plugin(plugin, config)
  await waitFor(
    () => isolated.tools.schemas().some((entry) => entry.name === 'mcp_duplicate'),
    'the first instance loader',
  )
  isolated.plugin(plugin, config)
  await waitFor(
    () => lines.some((line) => line.includes('already in use by another tool-aggregator instance') && line.includes('"duplicate"')),
    'the duplicate server-name mount error',
  )
  // The first instance keeps working: the claim only rejects the newcomer.
  assert.ok(
    isolated.tools.schemas().some((entry) => entry.name === 'mcp_duplicate'),
    'the first instance must keep its loader',
  )
  await isolated.fiber.dispose()
})

await check(47, 'a spec-invalid tools/call result still reaches the renderer (raw request path is locked)', async () => {
  const isolated = new Context()
  isolated.plugin(SystemPrompt)
  isolated.plugin(ToolRuntime, {})
  await waitFor(() => isolated.tools !== undefined, 'the isolated tools service')
  isolated.plugin(plugin, {
    servers: {
      odd: {
        description: 'Off-spec result server',
        mode: 'lazy',
        command: process.execPath,
        args: [ODD_RESULT],
      },
    },
  })
  try {
    await waitFor(() => isolated.tools.schemas().some((entry) => entry.name === 'mcp_odd'), 'the odd-result loader')
    const loaded = await isolated.tools.execute({ callId: 'odd-load', name: 'mcp_odd', arguments: {}, signal })
    assert.equal(loaded.isError, false, 'the off-spec server must load')
    const result = await isolated.tools.execute({
      callId: 'odd-call',
      name: 'mcp__odd__odd',
      arguments: {},
      signal,
    })
    // The result schema must stay ours: had the request fallen back to the
    // client library's spec validator, this call would fail with InvalidResult
    // instead of handing the spec-invalid block to the renderer.
    assert.equal(result.isError, false, `the spec-invalid result must not fail the call: ${textOf(result)}`)
    assert.equal(textOf(result), '{"type":"text"}')
  } finally {
    await isolated.fiber.dispose()
  }
})

await check(48, 'a server without the tools capability loads empty and is never asked to list', async () => {
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
  isolated.plugin(plugin, {
    servers: {
      notools: {
        description: 'Server without a tools capability',
        mode: 'lazy',
        command: process.execPath,
        args: [NO_TOOLS],
        env: { ECHO_LOG: file('notools.log') },
      },
    },
  })
  try {
    await waitFor(() => isolated.tools.schemas().some((entry) => entry.name === 'mcp_notools'), 'the no-tools loader')
    const loaded = await isolated.tools.execute({ callId: 'notools-load', name: 'mcp_notools', arguments: {}, signal })
    assert.equal(loaded.isError, false, `a tools-less server must still load: ${textOf(loaded)}`)
    assert.ok(
      !isolated.tools.schemas().some((entry) => entry.name.startsWith('mcp__notools__')),
      'no tool may be registered for a server without the capability',
    )
    assert.ok(
      lines.some((line) => line.includes('declares no tools capability')),
      'the empty-catalogue disposition must be logged, not silent',
    )
    assert.equal(countLines('notools.log', 'list'), 0, 'the plugin must not ask such a server for a tool list')
  } finally {
    await isolated.fiber.dispose()
  }
})

await check(49, "the server's own MCP instructions surface in the load result", async () => {
  const isolated = new Context()
  isolated.plugin(SystemPrompt)
  isolated.plugin(ToolRuntime, {})
  await waitFor(() => isolated.tools !== undefined, 'the isolated tools service')
  isolated.plugin(plugin, {
    servers: {
      instructionssrv: {
        description: 'Server that ships instructions',
        mode: 'lazy',
        command: process.execPath,
        args: [INSTRUCTIONS],
      },
    },
  })
  try {
    await waitFor(
      () => isolated.tools.schemas().some((entry) => entry.name === 'mcp_instructionssrv'),
      'the instructions loader',
    )
    const loaded = await isolated.tools.execute({
      callId: 'instr-load',
      name: 'mcp_instructionssrv',
      arguments: {},
      signal,
    })
    assert.equal(loaded.isError, false, textOf(loaded))
    const text = textOf(loaded)
    assert.match(text, /^ok\n\n### MCP server: instructionssrv\n\n/, 'the instructions must be attributed to their server')
    assert.match(text, /read before writing/, "the server's own instruction text must reach the model")
    assert.ok(
      isolated.tools.schemas().some((entry) => entry.name === 'mcp__instructionssrv__ping'),
      'the load must still register the tools',
    )
  } finally {
    await isolated.fiber.dispose()
  }
})

await check(50, 'instructions over maxInstructionBytes fail the load and name the limit', async () => {
  const isolated = new Context()
  isolated.plugin(SystemPrompt)
  isolated.plugin(ToolRuntime, {})
  await waitFor(() => isolated.tools !== undefined, 'the isolated tools service')
  isolated.plugin(plugin, {
    servers: {
      longinstr: {
        description: 'Server whose instructions exceed the cap',
        mode: 'lazy',
        command: process.execPath,
        args: [INSTRUCTIONS],
        maxInstructionBytes: 16,
        env: { ECHO_INSTRUCTION: 'x'.repeat(64) },
      },
    },
  })
  try {
    await waitFor(
      () => isolated.tools.schemas().some((entry) => entry.name === 'mcp_longinstr'),
      'the long-instructions loader',
    )
    const loaded = await isolated.tools.execute({
      callId: 'longinstr-load',
      name: 'mcp_longinstr',
      arguments: {},
      signal,
    })
    assert.equal(loaded.isError, true, 'an over-long instruction block must fail the load')
    assert.match(textOf(loaded), /maxInstructionBytes limit of 16 bytes/, 'the failure must name the configured limit')
    assert.ok(
      isolated.tools.schemas().some((entry) => entry.name === 'mcp_longinstr'),
      'the loader must survive a failed load so the operator can fix the cap',
    )
    assert.ok(
      !isolated.tools.schemas().some((entry) => entry.name.startsWith('mcp__longinstr__')),
      'a failed load must not register tools',
    )
  } finally {
    await isolated.fiber.dispose()
  }
})

await check(51, 'a loaded server publishes its resources through the host resource runtime', async () => {
  const isolated = new Context()
  isolated.plugin(SystemPrompt)
  isolated.plugin(ToolRuntime, {})
  isolated.plugin(McpResources)
  await waitFor(() => isolated.tools !== undefined, 'the isolated tools service')
  isolated.plugin(plugin, {
    servers: {
      res: {
        description: 'Server with resources',
        mode: 'lazy',
        command: process.execPath,
        args: [RESOURCES_SERVER],
        env: { ECHO_LOG: file('res.log') },
      },
    },
  })
  try {
    await waitFor(() => isolated.tools.schemas().some((entry) => entry.name === 'mcp_res'), 'the resources loader')
    assert.ok(
      !isolated.tools.schemas().some((entry) => entry.name === 'list_mcp_resources'),
      'the shared resource tools must not exist before any server is expanded',
    )
    const loaded = await isolated.tools.execute({ callId: 'res-load', name: 'mcp_res', arguments: {}, signal })
    assert.equal(loaded.isError, false, `the resources server must load: ${textOf(loaded)}`)
    await waitFor(
      () => isolated.tools.schemas().some((entry) => entry.name === 'list_mcp_resources'),
      'the shared resource tools after a load',
    )
    const listed = await isolated.tools.execute({
      callId: 'res-list',
      name: 'list_mcp_resources',
      arguments: { server: 'res' },
      signal,
    })
    assert.equal(listed.isError, false, `listing resources must work: ${textOf(listed)}`)
    assert.match(textOf(listed), /fixture:\/\/doc\/readme/, 'the server resource must be reachable')
    const read = await isolated.tools.execute({
      callId: 'res-read',
      name: 'read_mcp_resource',
      arguments: { server: 'res', uri: 'fixture://doc/readme' },
      signal,
    })
    assert.equal(read.isError, false, `reading a resource must work: ${textOf(read)}`)
    assert.match(textOf(read), /resource body from the fixture/, 'the resource body must come from the server')
    assert.equal(countLines('res.log', 'read'), 1, 'exactly one resources/read must reach the server')
    // Hiding the server withdraws its resource surface again.
    const hidden = await isolated.tools.execute({ callId: 'res-hide', name: 'mcp_res', arguments: {}, signal })
    assert.equal(hidden.isError, false, textOf(hidden))
    await waitFor(
      () => !isolated.tools.schemas().some((entry) => entry.name === 'list_mcp_resources'),
      'the shared resource tools to disappear with the unload',
    )
  } finally {
    await isolated.fiber.dispose()
  }
})

await check(52, 'without the resource runtime the plugin still loads servers and says so once', async () => {
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
  isolated.plugin(plugin, {
    servers: {
      resalone: {
        description: 'Server loaded without a resource runtime',
        mode: 'lazy',
        command: process.execPath,
        args: [RESOURCES_SERVER],
      },
    },
  })
  try {
    await waitFor(() => isolated.tools.schemas().some((entry) => entry.name === 'mcp_resalone'), 'the loader')
    const loaded = await isolated.tools.execute({ callId: 'resalone-load', name: 'mcp_resalone', arguments: {}, signal })
    assert.equal(loaded.isError, false, `the load must succeed without the runtime: ${textOf(loaded)}`)
    assert.ok(
      isolated.tools.schemas().some((entry) => entry.name === 'mcp__resalone__ping'),
      'the tools must still register',
    )
    assert.ok(
      !isolated.tools.schemas().some((entry) => entry.name === 'list_mcp_resources'),
      'no resource tool may appear without the runtime',
    )
    assert.equal(
      lines.filter((line) => line.includes('no mcpResources service in this composition')).length,
      1,
      'the unbridged case must be explained exactly once',
    )
  } finally {
    await isolated.fiber.dispose()
  }
})

await check(53, 'mounting never waits for an MCP child: a hanging probe server cannot block boot', async () => {
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
  // The probe connects on mount and this child never answers; the default
  // connectTimeoutMs is 30s, so a mount that waited for it could not be visible
  // inside the deadline below.
  const mountedAt = Date.now()
  isolated.plugin(plugin, {
    servers: {
      hangboot: {
        description: 'Server whose handshake never completes',
        mode: 'auto',
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 1e9)'],
      },
    },
  })
  try {
    await waitFor(
      () => isolated.tools.schemas().some((entry) => entry.name === 'mcp_hangboot'),
      'the loader to appear without waiting for the probe',
      1500,
    )
    assert.ok(
      Date.now() - mountedAt < 1500,
      'the loader must be registered while the MCP child is still connecting',
    )
    assert.ok(
      !isolated.tools.schemas().some((entry) => entry.name.startsWith('mcp__hangboot__')),
      'a server that never answered must not reveal tools',
    )
    assert.ok(
      lines.some((line) => line.includes('registered')),
      'mount must still log its loader registration',
    )
  } finally {
    await isolated.fiber.dispose()
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
