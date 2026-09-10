/**
 * Configuration and shared shapes for the lazy-loading MCP tool plugin.
 *
 * The plugin never imports a DSH package at runtime: every harness service is
 * reached through the Cordis context, so only `@modelcontextprotocol/sdk` and
 * Node builtins are real dependencies.
 */

/** One MCP server entry in the plugin config. */
export interface ServerConfig {
  /**
   * Capability sentence the model reads. It becomes the loader tool's
   * description, followed by the loader hint, so it is the model's only clue
   * about which server to load. Write what the server can do, not its name.
   */
  description?: string
  /**
   * How the server's tools reach the model.
   * - `auto` (default): eager when the server exposes at most
   *   {@link PluginConfig.singleToolThreshold} tools, lazy otherwise.
   * - `lazy`: always register a loader tool; the real tools stay hidden until
   *   the model calls it.
   * - `eager`: always register the tools at startup; no loader tool.
   */
  mode?: 'auto' | 'lazy' | 'eager'
  /** Model-facing loader tool name; defaults to `mcp_<serverName>`. */
  loaderName?: string
  /**
   * Rules naming tools to hide from every agent once this server is loaded
   * (merged from the retired `inkstone-tool-hide` plugin; a per-agent
   * `ctx.tools.restrict({ deny })`, so the tools stay globally registered).
   *
   * Each entry is a rule matched against the discovered tool set at load time:
   * - a raw name rule (`organize_note`, `note_*`) is anchored (`^…$`) and
   *   matched against the MCP tool's raw name;
   * - a public name rule (`mcp__inkstone__organize_note`,
   *   `mcp__inkstone__get_*`) is anchored and matched against the tool's
   *   public name (`mcp__<server>__<raw>`);
   * - `*` matches any run of characters (including none), `?` exactly one.
   *
   * v0.5.0 exact raw/full names keep their behavior unchanged; the matched
   * public names are deduplicated into one deny list. The server's own loader
   * tool can never be masked: a rule textually equal to the loader name fails
   * plugin mount, and a glob that would cover the loader name is dropped from
   * the deny list with a one-time warning at load.
   */
  hiddenTools?: string[]
  /**
   * Rules naming tools that are never registered (registration axis, unlike
   * `hiddenTools` which is a per-agent visibility mask). Matched tools are
   * dropped from the discovered set before registration, so they count toward
   * no loaded-tool total, appear in no loader text, and are invisible to every
   * agent. Same rule syntax as {@link ServerConfig.hiddenTools}. The loader
   * tool is never a discovered tool, so `disabledTools` cannot disable a
   * server's own loader; an exact rule textually equal to the loader name
   * fails plugin mount anyway.
   */
  disabledTools?: string[]
  /** Replace individual tool descriptions, keyed by raw MCP tool name. */
  toolDescriptions?: Record<string, string>
  /**
   * A built-in description map to merge under {@link toolDescriptions}.
   * `desktop-touch` is the preset merged from the retired `trim-desktop-touch`
   * plugin; it also implies a 90-character parameter-description cap.
   */
  descriptionPreset?: string
  /**
   * Truncate every parameter `description` in the tool's schema to this many
   * characters. `0` (default) leaves schemas untouched.
   */
  maxParameterDescriptionChars?: number
  /** Defaults to `stdio`; `streamable-http` requires `url`. */
  transport?: 'stdio' | 'streamable-http'
  /** stdio only: executable to spawn. */
  command?: string
  /** stdio only: arguments passed to `command`. */
  args?: string[]
  /**
   * stdio only: extra environment entries merged over the SDK's minimal default
   * environment (PATH/HOME/…), so a partial map never loses `npx` resolution.
   */
  env?: Record<string, string>
  /** stdio only: working directory for the child process. */
  cwd?: string
  /** streamable-http only: endpoint URL. */
  url?: string
  /** streamable-http only: extra request headers (auth belongs here). */
  headers?: Record<string, string>
  /** Per `tools/call` deadline in milliseconds; defaults to 60_000. */
  toolCallTimeoutMs?: number
  /**
   * How many times a failed connect or tool discovery is retried before the
   * error is surfaced. `0` restores the v0.5.0 behavior (one attempt, fail
   * fast). Only establish/discovery is retried — a failed `tools/call` is
   * never replayed. Defaults to 1.
   */
  reconnectAttempts?: number
  /**
   * Base delay in milliseconds before the first retry; every further retry
   * doubles it (base × 2^n), capped at 30s. `0` retries immediately.
   * Defaults to 500.
   */
  reconnectBackoffMs?: number
  /**
   * Idle disconnect in milliseconds. When > 0 and this server currently has no
   * loaded tools (an unload left it empty), its MCP connection is closed after
   * this long; the next load reconnects lazily. `0` (default) keeps the
   * always-warm v0.5.0 behavior — unload does not close the connection.
   */
  idleDisconnectMs?: number
  /**
   * Discovery hard cap: the maximum number of `tools/list` pages fetched for
   * one real discovery. Cached tool lists are exempt (they were already bound
   * by the discovery that fetched them). Exceeding it fails the discovery with
   * a `DiscoveryLimitError` naming this server and `pages` — never retried and
   * never silently truncated. Defaults to 100.
   */
  maxToolListPages?: number
  /**
   * Discovery hard cap: the maximum number of tools one server may expose
   * (counted over raw discovered tools, before any {@link disabledTools}
   * filtering). Exceeding it fails the discovery with a `DiscoveryLimitError`
   * naming this server and `tools` — never retried and never truncated, even
   * if most tools would be filtered afterwards: the cap protects against an
   * out-of-control server's own catalogue. Defaults to 500.
   * The check is page-granular: tools are counted page by page, so a single
   * oversized page can briefly exceed the cap before discovery fails atomically.
   */
  maxToolsPerServer?: number
  /**
   * Discovery deadline in milliseconds for one real `tools/list` pagination
   * (cached lists are exempt). A discovery that does not finish in time fails
   * with a `DiscoveryLimitError` naming this server and `timeout`, and the
   * connection is dropped so a hung page request never blocks later calls.
   * Defaults to 60_000.
   */
  discoveryTimeoutMs?: number
}

/** Plugin config. */
export interface PluginConfig {
  /** MCP servers, keyed by the namespace used in `mcp__<server>__<tool>`. */
  servers?: Record<string, ServerConfig>
  /** Connection handshake deadline in milliseconds; defaults to 30_000. */
  connectTimeoutMs?: number
  /**
   * In `auto` mode, a server exposing at most this many tools is registered
   * eagerly instead of getting a loader tool. Defaults to 1, so a single-tool
   * MCP is simply always available. `0` gives every server a loader, which is
   * what makes every server per-session: an eager server keeps no loader, so
   * masking it per session would hide tools no session could reveal again.
   */
  singleToolThreshold?: number
  /** Sentence appended to every loader tool description. */
  loaderHint?: string
  /**
   * Probe every server once at startup to classify `auto` servers. Defaults to
   * true; `false` keeps every non-`eager` server lazy and spawns nothing until a
   * loader is called.
   */
  probeAtStartup?: boolean
}

/** One discovered MCP tool in both its wire identity and its model-facing name. */
export interface DiscoveredTool {
  /** The server's own tool name; the only name ever sent on the wire. */
  rawName: string
  /** The registry name `mcp__<server>__<rawName>`, normalized to the name contract. */
  publicName: string
  description: string
  /** The MCP input schema, passed through as the DSH parameter schema. */
  inputSchema: unknown
}
