# dsh-mcp-loader

Lazy-loading MCP tools for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH):
each multi-tool MCP server is represented by **one loader tool** (default `mcp_<server>`), and a server's real
tools enter the model context only after the loader is called. With many MCP servers installed, this removes the
fixed cost of every tool schema being present in every request — and keeps the visible tool list small enough
that the model picks the right tool.

## How it works

```
Initial tool list:   mcp_notes, mcp_browser, mcp_desktop, ...        (one loader per server)
   ↓ model calls mcp_notes({})
→ "ok"                     the next request exposes mcp__notes__search, mcp__notes__create, ...
   ↓ model calls mcp_notes({}) again
→ "ok (20 tool(s) hidden)" those tools leave the context
   ↓ a third call loads them again
```

The loader is a **toggle**: call once to load, call again to hide, call a third time to load again —
no separate "unload tool" occupies a slot. Single-tool servers (e.g. a lone `codegraph_explore`) are detected
at startup and stay resident without a loader.

### Registration model

- Tool schemas are projected when the prompt is assembled (`ctx.systemPrompt.tools(...)`), so tools registered
  inside one tool call appear in the model's next step of the same turn — no extra round trip.
- Startup registers only loaders (no process spawned). A one-time probe may connect `auto`/`eager` servers to
  count their tools: servers with ≤ `singleToolThreshold` tools become resident and their loader is removed;
  `mode: lazy` servers never participate in the probe and are not spawned at boot.
- Registration is deployment-wide (global), consistent with the official `dsh-mcp-client`, because
  `ctx.tools.restrict()` only filters inherited tools and rejects names that are not globally registered —
  per-agent hiding (`hiddenTools`) is built on top of global registration.

## Features

- **Per-server loader toggle** — load, hide, reload, with a visible result message (`ok`, `ok (N tool(s) hidden)`).
- **Modes** — `auto` (probe once at startup), `lazy` (always behind a loader, never probed), `eager` (always resident, no loader).
- **`hiddenTools`** — mask specific tools per agent after a server loads (`restrict({ deny })`), for every existing
  agent and for agents created later; masks are per-agent visibility only, the tools stay globally registered.
- **Description engineering** — per-server `description`, `descriptionPreset`, per-tool `toolDescriptions`
  overrides, and parameter-description truncation (`maxParameterDescriptionChars`), so the model-facing text
  says what the tool does and when to use it.
- **Resilience** — atomic registration (any failure rolls the server back to zero tools), shared concurrent
  attempts, `list_changed` resync (full-generation replace), raw `tools/call` (skips outputSchema validation of
  `structuredContent`, same as the official client), transport-failure discard-and-reconnect on next call.
- **Transports** — `stdio` (spawn `command`/`args`, `env` merged into the SDK default environment) and
  `streamable-http` (`url`/`headers`).
- **Config fail-fast** — unknown preset or invalid server name (`[A-Za-z0-9_-]{1,32}`) fails plugin mount with a
  named field.

## Install

```sh
npm install            # build/test locally
npm run build          # tsc → lib/
npm test               # real-link e2e: real cordis ctx + dsh-tools ToolRuntime + real MCP stdio subprocesses
```

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
| `servers.<n>.hiddenTools` | — | Tool names (raw or `mcp__s__t`) masked per agent after load |
| `servers.<n>.toolDescriptions` | — | Per-tool description overrides |
| `servers.<n>.descriptionPreset` | — | Built-in description tables (`desktop-touch`) |
| `servers.<n>.maxParameterDescriptionChars` | `0` | Truncate parameter descriptions (preset may imply one) |
| `servers.<n>.transport` | `stdio` | `stdio` or `streamable-http` |
| `servers.<n>.command`/`args`/`env`/`cwd` | — | stdio process to spawn |
| `servers.<n>.url`/`headers` | — | streamable-http endpoint and extra headers |
| `servers.<n>.toolCallTimeoutMs` | `60000` | Per `tools/call` timeout |
| `servers.<n>.reconnectAttempts` | `1` | Per user-visible operation (a loader load, a tool call, a startup probe): retries after a failed connect/discovery — connect and discovery share one budget of `reconnectAttempts + 1` tries (`0` = exactly one attempt, v0.5.0 behavior) |
| `servers.<n>.reconnectBackoffMs` | `500` | Base retry delay; each retry doubles it (×2ⁿ), capped at 30s |
| `servers.<n>.idleDisconnectMs` | `0` | Close an unloaded server's MCP connection after this idle time (`0` = always warm); the next load reconnects |
| `connectTimeoutMs` | `30000` | Connection handshake timeout |
| `singleToolThreshold` | `1` | `auto` mode: servers with ≤ this many tools stay resident |
| `loaderHint` | `Call to load this MCP server's tools; call again to hide them.` | Appended to every loader description |
| `probeAtStartup` | `true` | Probe `auto`/`eager` servers at startup (`lazy` never probed) |

## Known limitations

- Granularity is per server, not per tool (one loader per server).
- Startup probing is a snapshot: a server that later grows past the threshold stays revealed until restart (pin it with `mode: lazy`).
- Images/audio become `[image image/png]` text placeholders; only tools are bridged — MCP resources/prompts/
  progress and task-typed tools are not supported (consistent with `dsh-mcp-client`).
- Reconnection is bounded and lazy: one user-visible operation (a loader load, a tool call, a startup probe) draws
  from a single budget of `reconnectAttempts + 1` connect+discovery tries (`reconnectAttempts`/`reconnectBackoffMs`);
  a failed `tools/call` is surfaced immediately and never replayed. There is no eager background keep-alive/reconnect —
  an idle server with `idleDisconnectMs: 0` (the default) stays warm indefinitely, and one with `idleDisconnectMs > 0`
  is disconnected only while it has no loaded tools, reconnecting on the next load.
- Known lifecycle edges (accepted for now; a connection "generation" scheme is a later slice):
  - Disconnecting while another caller is connecting can, in a narrow window, leave two spawned children and orphan
    the losing one.
  - An idle disconnect waits for a connect attempt already in flight (up to `connectTimeoutMs`) before closing; retries
    that were only scheduled are cancelled instead of delaying the disconnect.
  - With the default `reconnectAttempts: 1`, deterministic discovery errors (e.g. a duplicated tool name) are retried
    once before surfacing; slice 03 adds explicit exclusions (DiscoveryLimitError and friends).

## Ecosystem position

dsh-mcp-loader is one of several DSH plugins that keep large MCP tool catalogs out of every request
(compare `dsh-mcp-lazy`, `dsh-capability-menu`, `dsh-tool-folder`, `dsh-mcp-lens`, `dsh-tool-search`).
Its differentiators: per-server loader toggles, per-agent `hiddenTools` masking, and model-facing description
presets — plus self-owned connections (`stdio` and `streamable-http`) instead of wrapping another MCP client.

## License

MIT
