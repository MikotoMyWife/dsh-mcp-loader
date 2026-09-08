import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { DiscoveredTool, ServerConfig } from './types.js';
/** Default per-`tools/call` deadline. */
export declare const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60000;
/** Default connection handshake deadline. */
export declare const DEFAULT_CONNECT_TIMEOUT_MS = 30000;
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
    /** Connect on first use; concurrent callers share the one attempt. */
    client(): Promise<Client>;
    /**
     * The server's tool list, cached until a `list_changed` notification or a
     * forced refresh. Connects on first call.
     */
    listTools(force?: boolean): Promise<DiscoveredTool[]>;
    /** Send one `tools/call` under the caller's cancellation and the call deadline. */
    callTool(rawName: string, args: unknown, signal: AbortSignal): Promise<McpCallResult>;
    /** Register the single re-sync listener for this connection. */
    onToolsChanged(listener: () => void): void;
    /** Connection state without triggering a connection. */
    status(): ConnectionStatus;
    close(): Promise<void>;
}
/** One-line error text for logs and model-facing messages. */
export declare function messageOf(error: unknown): string;
//# sourceMappingURL=connection.d.ts.map