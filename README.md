# dsh-mcp-loader

Lazy-loading MCP tools for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH):
each multi-tool MCP server is represented by **one loader tool** (default `mcp_<server>`), and a server's real
tools enter the model context only after the loader is called. With many MCP servers installed, this removes the
fixed cost of every tool schema being present in every request — and keeps the visible tool list small enough
that the model picks the right tool. **A load is per session**: the session that called the loader (and its
subagents) sees the tools, every other session in the process — including sessions created afterwards — keeps
seeing just the loader.

## How it works

```
Initial tool list:   mcp_notes, mcp_browser, mcp_desktop, ...        (one loader per server)
   ↓ model calls mcp_notes({})
→ "ok"                     the next request exposes mcp__notes__search, mcp__notes__create, ...
   ↓ model calls mcp_notes({}) again
→ "ok (20 tool(s) hidden)" those tools leave the context
   ↓ a third call loads them again
```

The loader is a **toggle**, scoped to the session that calls it: call once to load, call again to hide, call a
third time to load again — no separate "unload tool" occupies a slot. A second session toggling the same server
has its own state: it never inherits the first session's disclosure, and hiding in one session never withdraws
the tools from another. The underlying generation is released only once its last holder drops it. Servers with
≤ `singleToolThreshold` tools are detected at startup and stay resident without a loader — and because nothing
could ever reveal them again, they are never masked per session (`singleToolThreshold: 0` gives every server a
loader, so every server is per-session).

### Registration model

- Tool schemas are projected when the prompt is assembled (`ctx.systemPrompt.tools(...)`), so tools registered
  inside one tool call appear in the model's next step of the same turn — no extra round trip.
- Startup registers only loaders (no process spawned). A one-time probe may connect `auto`/`eager` servers to
  count their tools: servers with ≤ `singleToolThreshold` tools become resident and their loader is removed;
  `mode: lazy` servers never participate in the probe and are not spawned at boot.
- Registration is deployment-wide (global), consistent with the official `dsh-mcp-client`, because
  `ctx.tools.restrict()` only filters inherited tools and rejects names that are not globally registered —
  per-agent hiding (`hiddenTools`) is built on top of global registration.
- Visibility is per session. Registering globally puts the tools in the layer every agent inherits, so a load
  that no session scoped would leak into every other session; instead the loader records the calling session as
  a *holder*, and every agent that is not a holder (nor a subagent of one) receives a `restrict({ deny })` mask
  over that generation's public names. A generation loaded with no holder at all — a call with no agent, e.g. a
  test or a script driving `ctx.tools.execute` — keeps the deployment-wide v0.5.0 behavior.
  Subagents inherit: the walk follows `parentSession` while the child is a `subagent`, and deliberately stops at
  a fork (`isSeeded`, no `origin`), which is a new session and starts unexpanded.

## Features

- **Per-server loader toggle** — load, hide, reload, with a visible result message (`ok`, `ok (N tool(s) hidden)`),
  and per session: one session's load is invisible to every other session (and its subagents inherit it).
- **Modes** — `auto` (probe once at startup), `lazy` (always behind a loader, never probed), `eager` (always resident, no loader).
- **`hiddenTools`** — mask specific tools per agent after a server loads (`restrict({ deny })`), for every existing
  agent and for agents created later. Entries are rules — exact raw names (`ping`), exact public names
  (`mcp__solo__ping`) or globs (`e*`, `mcp__solo__*`, `?` matches one char) — expanded over the tools the server
  actually exposes at load time. Masks are per-agent visibility only; the tools stay globally registered.
- **`disabledTools`** — never register matched tools at all (registration axis, global): the tools are dropped
  before registration, count toward no loaded-tool total, and are invisible to every agent. Same rule syntax as
  `hiddenTools`. The loader tool is never affected (it is not a discovered MCP tool).
- **Description engineering** — per-server `description`, `descriptionPreset`, per-tool `toolDescriptions`
  overrides, and parameter-description truncation (`maxParameterDescriptionChars`), so the model-facing text
  says what the tool does and when to use it.
- **Resilience** — atomic registration (any failure rolls the server back to zero tools), shared concurrent
  attempts, `list_changed` resync (full-generation replace), raw `tools/call` (skips outputSchema validation of
  `structuredContent`, same as the official client), transport-failure discard-and-reconnect on next call.
- **Bounded disposal** — every dropped generation is closed under a `closeTimeoutMs` deadline. A transport that
  cannot confirm its closure is logged and poisons that connection: it refuses to reconnect, because the child
  may still be running and a fresh connect would start a second one for the same server.
- **Child environment** — a stdio server is spawned with the parent environment minus every credential-shaped key
  (`/KEY|PASSWORD|SECRET|TOKEN/i`) and every `DSH_*` fact, so an `npx`/`mcp-remote` server keeps `PATH`,
  `NPM_CONFIG_*` and the proxy variables (with `NODE_USE_ENV_PROXY` set when they are `http(s)` URLs) that the
  SDK's minimal default environment would have dropped. A configured `env` entry merges last and always wins.
- **Discovery hard caps** — per server, a real discovery is bounded by `maxToolListPages` pages, `maxToolsPerServer`
  raw tools and a `discoveryTimeoutMs` deadline; exceeding any of them fails the load/re-sync with an error naming
  the server and the reason, keeps the loader tool, and is never retried.
- **Ordered re-syncs** — a per-server monotonic discovery generation makes sure two concurrent `list_changed`
  re-syncs (or a re-sync racing a load) can never have an older snapshot land after — and overwrite — a newer one:
  a stale discovery result is discarded instead of being applied.
- **Transports** — `stdio` (spawn `command`/`args` with a scrubbed child environment) and
  `streamable-http` (`url`/`headers`).
- **Config fail-fast** — unknown preset or invalid server name (`[A-Za-z0-9_-]{1,32}`) fails plugin mount with a
  named field.

## Install

```sh
npm install            # build/test locally
npm run build          # tsc → lib/
npm test               # real-link e2e: real cordis ctx + dsh-tools ToolRuntime + real MCP stdio subprocesses
```

The MCP client layer is `@modelcontextprotocol/client` 2.0.0 — the same line the harness itself ships — and it is
the only runtime dependency besides Node builtins. The v1 `@modelcontextprotocol/sdk` stays a devDependency for the
test fixtures, which are v1 *servers*.

Then register the plugin in your profile (id `mcp-loader`, package `dsh-mcp-loader`) and add your servers:

```yaml
- id: mcp-loader
  name: dsh-mcp-loader
  config:
    servers:
      notes:
        description: "Search, read, create and organize personal notes. Use when the task involves the user's notes."
        command: npx
        args: ['-y', 'mcp-remote', 'https://example.invalid/mcp']
      desktop:
        description: "Control the real desktop ..."
        mode: lazy
        command: npx
        args: ['-y', 'example-desktop-mcp']
```

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `servers` | `{}` | Server table; the key is the namespace of `mcp__<server>__<tool>` |
| `servers.<n>.description` | — | Loader description body: what it can do + when to use it |
| `servers.<n>.mode` | `auto` | `auto` / `lazy` (always loader) / `eager` (always resident) |
| `servers.<n>.loaderName` | `mcp_<server>` | Model-visible loader name |
| `servers.<n>.hiddenTools` | — | Tool rules (raw/public exact names or globs) masked per agent after load; glob `*` matches any run, `?` one char |
| `servers.<n>.disabledTools` | — | Tool rules never registered (same syntax as `hiddenTools`) |
| `servers.<n>.toolDescriptions` | — | Per-tool description overrides |
| `servers.<n>.descriptionPreset` | — | Built-in description tables (`desktop-touch`) |
| `servers.<n>.maxParameterDescriptionChars` | `0` | Truncate parameter descriptions (preset may imply one) |
| `servers.<n>.transport` | `stdio` | `stdio` or `streamable-http` |
| `servers.<n>.command`/`args`/`env`/`cwd` | — | stdio process to spawn; `env` merges over the scrubbed parent environment (credential-shaped keys and `DSH_*` are withheld, proxies and `NPM_CONFIG_*` are kept) |
| `servers.<n>.url`/`headers` | — | streamable-http endpoint and extra headers |
| `servers.<n>.toolCallTimeoutMs` | `60000` | Per `tools/call` timeout |
| `servers.<n>.reconnectAttempts` | `1` | Per user-visible operation (a loader load, a tool call, a startup probe): retries after a failed connect/discovery — connect and discovery share one budget of `reconnectAttempts + 1` tries (`0` = exactly one attempt, v0.5.0 behavior) |
| `servers.<n>.reconnectBackoffMs` | `500` | Base retry delay; each retry doubles it (×2ⁿ), capped at 30s |
| `servers.<n>.idleDisconnectMs` | `0` | Close an unloaded server's MCP connection after this idle time (`0` = always warm); the next load reconnects |
| `servers.<n>.maxToolListPages` | `100` | Discovery hard cap: max `tools/list` pages per real discovery; exceeding it fails the load/re-sync naming `pages` (never retried, never truncated) |
| `servers.<n>.maxToolsPerServer` | `500` | Discovery hard cap: max raw tools one server may expose; exceeding it fails naming `tools` (counted before `disabledTools`) |
| `servers.<n>.discoveryTimeoutMs` | `60000` | Discovery deadline for one real pagination; a timeout fails naming `timeout` and drops the connection so a hung server never blocks later calls |
| `servers.<n>.closeTimeoutMs` | `5000` | Deadline for confirming that a dropped server's transport really closed; an unconfirmed closure is logged and the connection refuses to reconnect (the child may still be running, so a new connect would overlap it) |
| `connectTimeoutMs` | `30000` | Connection handshake timeout |
| `singleToolThreshold` | `1` | `auto` mode: servers with ≤ this many tools stay resident |
| `loaderHint` | `Call to load this MCP server's tools into this session; call again to hide them.` | Appended to every loader description |
| `probeAtStartup` | `true` | Probe `auto`/`eager` servers at startup (`lazy` never probed) |

## Hiding vs disabling tools

Two options remove tools from the model's sight; they act on different axes and must not be conflated.
Both accept the same rule syntax:

- an **exact raw name**, e.g. `ping` — matches `^ping$` against the MCP tool's raw name;
- an **exact public name**, e.g. `mcp__inkstone__search` — matches against the public name `mcp__<server>__<tool>`;
- a **glob** in either spelling, e.g. `note_*`, `search_?`, `mcp__inkstone__*` — `*` matches any run of characters
  (including none), `?` matches exactly one; the pattern is anchored (`^…$`).

Rules are expanded over the tool list the server actually exposes when it loads (and re-expanded on re-sync), so a
pattern only ever hides tools that exist, and multiple rules hitting the same tool deny it once. Exact names keep
their v0.5.0 behavior unchanged.

| Configuration | Mechanism | Scope | Takes effect |
|---|---|---|---|
| Loader called twice / `mode: lazy` never loaded | Registry removal (unload / not registered) | All agents | On call |
| Loaded without holding the loader (default) | Visibility removal — `restrict({ deny })` per agent, lifted when the session itself opts in | Non-holder sessions only | After load, applied per agent |
| `disabledTools` | Registry removal — matched tools are filtered out **before** registration | All agents (globally banned) | On load / re-sync |
| `hiddenTools` | Visibility removal — `restrict({ deny })` per agent | Each agent (per-agent mask) | After load, applied per agent |

The three axes are independent: being in the registry ≠ being visible ≠ being callable. `disabledTools` is the
registry axis (a tool that is never registered is unreachable), while the per-session default mask and
`hiddenTools` stay on the visibility axis (tools stay globally registered, only masked per agent). The two masks
are merged per agent, so a server can be both hidden by configuration and unheld by the agent in question.
There is deliberately **no execution axis**: this plugin adds no `pre-execute` deny listener — a tool that is
registered and visible is callable. (An execution-axis deny would only be worth adding if a future mode keeps
tools registered while projecting them away.)

**Lockout protection.** A server's own loader tool can never be hidden or disabled by its own rules:

- an exact rule textually equal to the loader name (`loaderName` or the default `mcp_<server>`) is rejected at
  plugin mount with a message naming the server and the loader;
- a glob that would also cover the loader name is dropped from the deny mask and a one-time warning is logged at
  load; the loader stays visible so the server can always be toggled again.

`disabledTools` cannot disable a loader at all: loaders are plugin-registered tools, never discovered MCP tools.

**When everything is disabled.** A server whose every discovered tool matches `disabledTools` is treated as an
empty server: a loader call returns `ok` and registers nothing (logged as `loaded 0 tool(s) ... (N suppressed by
disabledTools)`), and under `auto`/`eager` the startup probe removes the loader entirely — the server then only
returns if you edit its configuration and restart (keep `mode: lazy` if you may want to re-enable tools without a
restart).

**Interaction with the discovery caps.** The per-server discovery caps live in the connection layer and
count *raw discovered* tools (pages / tool count / deadline), while `disabledTools` filters later, in the loader
layer. A server that reports more raw tools than the cap will therefore fail discovery before `disabledTools` can
help — that is intentional: the cap protects against an out-of-control server's own catalogue, not against your
configuration of it. Raise the cap or drop the server if you need to ban most of a huge catalogue. Cap failures
are deterministic and are never retried.

## Known limitations

- Granularity is per server, not per tool (one loader per server).
- Tool rules are expanded when a generation loads and re-expanded when it re-syncs, so a glob sees the tool set of
  the moment. A mask is applied to an agent once per server (the per-agent `restrict` is not replayed on re-sync),
  so a tool that first appears in a later re-sync is masked for agents created after that re-sync, not for agents
  that were already masked under the earlier expansion.
- Startup probing is a snapshot: a server that later grows past the threshold stays revealed until restart (pin it with `mode: lazy`).
- Only one bridge may serve a given server name: each configured name is claimed at mount time, and a second
  instance (another mount of this plugin, or the official `dsh-mcp-client` on the same name) is refused with a
  named error instead of silently failing to register — registration is global, so the public tool names would collide.
- Images/audio become `[image image/png]` text placeholders; only tools are bridged — MCP resources/prompts/
  progress and task-typed tools are not supported (consistent with `dsh-mcp-client`).
- Reconnection is bounded and lazy: one user-visible operation (a loader load, a tool call, a startup probe) draws
  from a single budget of `reconnectAttempts + 1` connect+discovery tries (`reconnectAttempts`/`reconnectBackoffMs`);
  a failed `tools/call` is surfaced immediately and never replayed. There is no eager background keep-alive/reconnect —
  an idle server with `idleDisconnectMs: 0` (the default) stays warm indefinitely, and one with `idleDisconnectMs > 0`
  is disconnected only while it has no loaded tools, reconnecting on the next load.
- Known lifecycle edges (accepted for now; a connection "generation" scheme for these is a later slice):
  - Disconnecting while another caller is connecting can, in a narrow window, leave two spawned children and orphan
    the losing one.
  - An idle disconnect waits for a connect attempt already in flight (up to `connectTimeoutMs`) before closing; retries
    that were only scheduled are cancelled instead of delaying the disconnect.
  - With the default `reconnectAttempts: 1`, deterministic discovery errors (e.g. a duplicated tool name) are retried
    once before surfacing. Discovery hard caps are the exception: a `DiscoveryLimitError` (page/tool limit or
    deadline) is deterministic and surfaces immediately, never retried.

## Ecosystem position

dsh-mcp-loader is one of several DSH plugins that keep large MCP tool catalogs out of every request
(compare `dsh-mcp-lazy`, `dsh-capability-menu`, `dsh-tool-folder`, `dsh-mcp-lens`, `dsh-tool-search`).
Its differentiators: per-server loader toggles, per-agent `hiddenTools` masking, and model-facing description
presets — plus self-owned connections (`stdio` and `streamable-http`) instead of wrapping another MCP client.

## License

MIT
