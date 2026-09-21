import { Client } from '@modelcontextprotocol/client';
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
/** Default discovery hard cap: pages of `tools/list` per real discovery. */
export declare const DEFAULT_MAX_TOOL_LIST_PAGES = 100;
/** Default discovery hard cap: raw tools one server may expose. */
export declare const DEFAULT_MAX_TOOLS_PER_SERVER = 500;
/** Default discovery deadline for one real pagination, in milliseconds. */
export declare const DEFAULT_DISCOVERY_TIMEOUT_MS = 60000;
/** Default deadline for confirming that a transport really closed. */
export declare const DEFAULT_CLOSE_TIMEOUT_MS = 5000;
/** Default ceiling for one server's MCP instructions, in UTF-8 bytes. */
export declare const DEFAULT_MAX_INSTRUCTION_BYTES = 32768;
/** Which discovery hard cap was hit. */
export type DiscoveryLimitReason = 'pages' | 'tools' | 'timeout';
/**
 * A deterministic discovery hard cap was exceeded (or the discovery deadline
 * passed). The loader never retries these: retrying cannot shrink a server's
 * catalogue, and a server that does not answer in time rarely will on a second
 * try. The message names the server and the reason so operators can raise the
 * right cap.
 */
export declare class DiscoveryLimitError extends Error {
    readonly reason: DiscoveryLimitReason;
    constructor(serverName: string, reason: DiscoveryLimitReason, limit: number);
}
/**
 * A teardown could not confirm that the server's transport closed, so this
 * connection refuses to reconnect: the child process may still be alive and a
 * fresh connect would start a second one for the same server. Only a plugin (or
 * session) restart clears this — deliberately not retryable, because retrying is
 * exactly what would create the overlapping process.
 */
export declare class UnconfirmedCloseError extends Error {
    constructor(serverName: string);
}
/**
 * A server's MCP instructions exceeded `maxInstructionBytes`.
 *
 * Deterministic, so never retried: a server that sends an over-long instruction
 * block will send it again. Surfacing the load failure (instead of truncating)
 * follows the plugin's cap discipline — a silent cut would hand the model a
 * half-sentence and hide the operator's missing configuration.
 */
export declare class InstructionLimitError extends Error {
    constructor(serverName: string, limit: number, actual: number);
}
/**
 * Whether a failed connect or discovery is worth retrying.
 *
 * Only transient establish/transport/timeout failures qualify. The v2 client
 * splits what v1 packed into `McpError`: a local failure is an `SdkError` with a
 * string code (`ConnectionClosed` / `RequestTimeout` are the transient ones, and
 * a dead transport or an in-flight timeout maps to them), while a JSON-RPC error
 * the server actually answered is a `ProtocolError` — retrying an answered
 * error cannot help, so every `ProtocolError` is final. Plain errors (spawn
 * failures, our connect wrapper, handshake timeouts, "Not connected") are
 * establish failures by nature and are retried. Deterministic failures are never
 * retried: discovery caps (`DiscoveryLimitError`) cannot shrink a server's
 * catalogue on a second try, and an unconfirmed close
 * ({@link UnconfirmedCloseError}) must not spawn an overlapping child. A failed
 * `tools/call` never reaches this predicate — {@link ServerConnection.callTool}
 * invalidates and rethrows without replaying.
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
/** The transport type `Client.connect` accepts. */
type TransportLike = Parameters<Client['connect']>[0];
/** Construction options for one {@link ServerConnection}. */
export interface ServerConnectionOptions {
    /** Connection handshake deadline in milliseconds. */
    connectTimeoutMs?: number;
    /**
     * Test seam: build the transport for this connection. Defaults to stdio or
     * streamable-http per config. A transport whose `close()` never settles cannot
     * be produced with a real stdio child on Windows (Node terminates the process
     * outright), so the close barrier is verified through this seam.
     */
    transportFactory?: (name: string, config: ServerConfig) => TransportLike;
}
export declare class ServerConnection {
    #private;
    readonly name: string;
    constructor(name: string, config: ServerConfig, logger: Logger, options?: ServerConnectionOptions);
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
     * The connected server's MCP instructions, or `undefined` when it sent none —
     * or when no client is live, so a dropped connection never reports a stale
     * instruction block.
     */
    instructions(): string | undefined;
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
    /**
     * Permanent teardown: close the current client and refuse further use.
     *
     * Bounded by `closeTimeoutMs` — if the transport will not confirm closure the
     * connection logs it and is poisoned, so teardown can never hang forever on a
     * server that ignores shutdown.
     */
    close(): Promise<void>;
}
/** One-line error text for logs and model-facing messages. */
export declare function messageOf(error: unknown): string;
export {};
//# sourceMappingURL=connection.d.ts.map