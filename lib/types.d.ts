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
    description?: string;
    /**
     * How the server's tools reach the model.
     * - `auto` (default): eager when the server exposes at most
     *   {@link PluginConfig.singleToolThreshold} tools, lazy otherwise.
     * - `lazy`: always register a loader tool; the real tools stay hidden until
     *   the model calls it.
     * - `eager`: always register the tools at startup; no loader tool.
     */
    mode?: 'auto' | 'lazy' | 'eager';
    /** Model-facing loader tool name; defaults to `mcp_<serverName>`. */
    loaderName?: string;
    /**
     * Tools to hide from every agent once this server is loaded (merged from the
     * retired `inkstone-tool-hide` plugin). Each entry may be a raw MCP tool name
     * (`organize_note`) or a public one (`mcp__inkstone__organize_note`); the
     * plugin applies a per-agent `ctx.tools.restrict({ deny })`.
     */
    hiddenTools?: string[];
    /** Replace individual tool descriptions, keyed by raw MCP tool name. */
    toolDescriptions?: Record<string, string>;
    /**
     * A built-in description map to merge under {@link toolDescriptions}.
     * `desktop-touch` is the preset merged from the retired `trim-desktop-touch`
     * plugin; it also implies a 90-character parameter-description cap.
     */
    descriptionPreset?: string;
    /**
     * Truncate every parameter `description` in the tool's schema to this many
     * characters. `0` (default) leaves schemas untouched.
     */
    maxParameterDescriptionChars?: number;
    /** Defaults to `stdio`; `streamable-http` requires `url`. */
    transport?: 'stdio' | 'streamable-http';
    /** stdio only: executable to spawn. */
    command?: string;
    /** stdio only: arguments passed to `command`. */
    args?: string[];
    /**
     * stdio only: extra environment entries merged over the SDK's minimal default
     * environment (PATH/HOME/…), so a partial map never loses `npx` resolution.
     */
    env?: Record<string, string>;
    /** stdio only: working directory for the child process. */
    cwd?: string;
    /** streamable-http only: endpoint URL. */
    url?: string;
    /** streamable-http only: extra request headers (auth belongs here). */
    headers?: Record<string, string>;
    /** Per `tools/call` deadline in milliseconds; defaults to 60_000. */
    toolCallTimeoutMs?: number;
    /**
     * How many times a failed connect or tool discovery is retried before the
     * error is surfaced. `0` restores the v0.5.0 behavior (one attempt, fail
     * fast). Only establish/discovery is retried — a failed `tools/call` is
     * never replayed. Defaults to 1.
     */
    reconnectAttempts?: number;
    /**
     * Base delay in milliseconds before the first retry; every further retry
     * doubles it (base × 2^n), capped at 30s. `0` retries immediately.
     * Defaults to 500.
     */
    reconnectBackoffMs?: number;
    /**
     * Idle disconnect in milliseconds. When > 0 and this server currently has no
     * loaded tools (an unload left it empty), its MCP connection is closed after
     * this long; the next load reconnects lazily. `0` (default) keeps the
     * always-warm v0.5.0 behavior — unload does not close the connection.
     */
    idleDisconnectMs?: number;
}
/** Plugin config. */
export interface PluginConfig {
    /** MCP servers, keyed by the namespace used in `mcp__<server>__<tool>`. */
    servers?: Record<string, ServerConfig>;
    /** Connection handshake deadline in milliseconds; defaults to 30_000. */
    connectTimeoutMs?: number;
    /**
     * In `auto` mode, a server exposing at most this many tools is registered
     * eagerly instead of getting a loader tool. Defaults to 1, so a single-tool
     * MCP is simply always available.
     */
    singleToolThreshold?: number;
    /** Sentence appended to every loader tool description. */
    loaderHint?: string;
    /**
     * Probe every server once at startup to classify `auto` servers. Defaults to
     * true; `false` keeps every non-`eager` server lazy and spawns nothing until a
     * loader is called.
     */
    probeAtStartup?: boolean;
}
/** One discovered MCP tool in both its wire identity and its model-facing name. */
export interface DiscoveredTool {
    /** The server's own tool name; the only name ever sent on the wire. */
    rawName: string;
    /** The registry name `mcp__<server>__<rawName>`, normalized to the name contract. */
    publicName: string;
    description: string;
    /** The MCP input schema, passed through as the DSH parameter schema. */
    inputSchema: unknown;
}
//# sourceMappingURL=types.d.ts.map