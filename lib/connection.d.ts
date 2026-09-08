import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { DiscoveredTool, ServerConfig } from './types.js';
/** Default per-`tools/call` deadline. */
export declare const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60000;
/** Default connection handshake deadline. */
export declare const DEFAULT_CONNECT_TIMEOUT_MS = 30000;
/** Default number of retries after a failed connect/discovery. */
export declare const DEFAULT_RECONNECT_ATTEMPTS = 1;
/** Default base delay before the first retry, in milliseconds. */
export declare const DEFAULT_RECONNECT_BACKOFF_MS = 500;
/** Backoff never exceeds this, whatever the exponent says. */
export declare const MAX_RETRY_BACKOFF_MS = 30000;
/**
 * Whether a failed connect or discovery is worth retrying.
 *
 * Only transient establish/transport/timeout failures qualify: the MCP SDK
 * maps a dead transport and an in-flight request timeout to
 * `McpError(ConnectionClosed / RequestTimeout)`, while any other `McpError` is
 * an answered protocol error a retry will not fix. Plain errors (spawn
 * failures, our connect wrapper, handshake timeouts) are establish failures by
 * nature and are retried. Slice 03 adds its deterministic discovery caps to the
 * exclusion list here. A failed `tools/call` never reaches this predicate —
 * {@link ServerConnection.callTool} invalidates and rethrows without replaying.
 */
export declare function isRetryable(error: unknown): boolean;
/** The logging surface the plugin needs; Cordis supplies it, tests may not. */
export interface Logger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}
/** The subset of an MCP `tools/call` result this plugin reads. */
export interface McpCallResult {
    content?: unknown;
    structuredContent?: unknown;
    isError?: boolean;
}
/** Connection state reported without forcing a connection. */
export interface ConnectionStatus {
    connected: boolean;
    /** Cached tool count, or `undefined` when the tool list was never fetched. */
    discovered: number | undefined;
}
/**
 * Derive the model-facing public name for one MCP tool.
 *
 * The clean case is `mcp__<serverName>__<rawName>` verbatim. When character
 * replacement or truncation changes the name, a 12-hex-char SHA-256 hash of the
 * identity is appended so distinct MCP identities never collapse into one name.
 * Mirrors `@deepseek-ai/dsh-mcp-client` so both bridges agree on naming.
 */
export declare function publicToolName(serverName: string, rawName: string): string;
/** Collect every configuration problem for one server entry, in report order. */
export declare function validateServerConfig(name: string, config: ServerConfig): string[];
export declare class ServerConnection {
    #private;
    readonly name: string;
    constructor(name: string, config: ServerConfig, logger: Logger, connectTimeoutMs?: number);
    /**
     * Connect on first use with the connection's retry budget; concurrent
     * callers share the one in-flight attempt. Only the *establish* is retried —
     * the tool-call path uses this, and the call itself is never retried.
     */
    client(): Promise<Client>;
    /**
     * The server's tool list, cached until a `list_changed` notification or a
     * forced refresh. Connects on first call.
     *
     * One retry unit is a full connect + discovery, and the operation draws from
     * the single `reconnectAttempts + 1` budget — a load, probe or resync never
     * multiplies its allowance across an inner connect retry. A mid-discovery
     * failure drops the client (it may be half-dead), so the next attempt — and
     * every later call — starts from a fresh connection.
     */
    listTools(force?: boolean): Promise<DiscoveredTool[]>;
    /** Send one `tools/call` under the caller's cancellation and the call deadline. */
    callTool(rawName: string, args: unknown, signal: AbortSignal): Promise<McpCallResult>;
    /** Register the single re-sync listener for this connection. */
    onToolsChanged(listener: () => void): void;
    /** Connection state without triggering a connection. */
    status(): ConnectionStatus;
    /**
     * Soft disconnect: close the current client (and any in-flight connect) and
     * drop the cached state, but keep this connection reusable.
     *
     * Unlike {@link close}, this does not set the closed flag and keeps the
     * list_changed listener, so the next `client()` / `listTools()` reconnects
     * lazily — used by the idle-disconnect timer in the loader, which must be
     * able to rebuild the connection on the next load.
     */
    disconnect(): Promise<void>;
    close(): Promise<void>;
}
/** One-line error text for logs and model-facing messages. */
export declare function messageOf(error: unknown): string;
//# sourceMappingURL=connection.d.ts.map