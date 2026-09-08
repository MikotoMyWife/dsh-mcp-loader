/**
 * One lazily-connected MCP server.
 *
 * The connection is created on first use (never at plugin load), shared by
 * every concurrent caller, and kept alive after `unload` so a re-load is
 * immediate. A transport-level failure drops the client so the next call
 * reconnects instead of failing forever.
 */
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
/** DeepSeek function-name contract: at most 64 characters. */
const MAX_PUBLIC_NAME_LENGTH = 64;
/** DeepSeek function-name contract: only `[A-Za-z0-9_-]` is allowed. */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
/** Hex chars of the SHA-256 identity hash appended on lossy normalization. */
const HASH_LENGTH = 12;
/** Default per-`tools/call` deadline. */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000;
/** Default connection handshake deadline. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
/**
 * Result schema that accepts any `tools/call` result shape.
 *
 * `Client.callTool` additionally validates `structuredContent` against the
 * tool's declared `outputSchema` and throws `-32602` when a server returns extra
 * properties — inkstone's `search` does exactly that. This bridge owns no output
 * contract, so it issues the raw request and skips that per-tool validator, the
 * same way `@deepseek-ai/dsh-mcp-client` does.
 */
const RAW_CALL_RESULT_SCHEMA = {
    safeParse: (value) => ({ success: true, data: value }),
};
/**
 * Derive the model-facing public name for one MCP tool.
 *
 * The clean case is `mcp__<serverName>__<rawName>` verbatim. When character
 * replacement or truncation changes the name, a 12-hex-char SHA-256 hash of the
 * identity is appended so distinct MCP identities never collapse into one name.
 * Mirrors `@deepseek-ai/dsh-mcp-client` so both bridges agree on naming.
 */
export function publicToolName(serverName, rawName) {
    const joined = `mcp__${serverName}__${rawName}`;
    const normalized = joined.replace(INVALID_NAME_CHARS, '_');
    if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH)
        return normalized;
    const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH);
    return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}
/** Collect every configuration problem for one server entry, in report order. */
export function validateServerConfig(name, config) {
    const problems = [];
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name))
        problems.push('server name must match [A-Za-z0-9_-]{1,32}');
    const transport = config.transport ?? 'stdio';
    if (transport === 'stdio') {
        if (typeof config.command !== 'string' || config.command.length === 0) {
            problems.push('stdio transport requires a non-empty "command"');
        }
        if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some((arg) => typeof arg !== 'string'))) {
            problems.push('"args" must be an array of strings');
        }
    }
    else if (transport === 'streamable-http') {
        if (typeof config.url !== 'string' || config.url.length === 0) {
            problems.push('streamable-http transport requires a non-empty "url"');
        }
    }
    else {
        problems.push(`unknown transport ${JSON.stringify(config.transport)}; expected "stdio" or "streamable-http"`);
    }
    if (config.toolCallTimeoutMs !== undefined
        && (!Number.isFinite(config.toolCallTimeoutMs) || config.toolCallTimeoutMs <= 0)) {
        problems.push('"toolCallTimeoutMs" must be a positive finite number');
    }
    return problems;
}
/** Reject after `ms` when `promise` has not settled. */
function withTimeout(promise, ms, what) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${what}`)), ms);
        promise.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (error) => {
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
}
export class ServerConnection {
    name;
    #config;
    #logger;
    #connectTimeoutMs;
    #toolCallTimeoutMs;
    #client;
    #connecting;
    #tools;
    #onListChanged;
    #closed = false;
    constructor(name, config, logger, connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS) {
        this.name = name;
        this.#config = config;
        this.#logger = logger;
        this.#connectTimeoutMs = connectTimeoutMs;
        this.#toolCallTimeoutMs = config.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;
    }
    /** Connect on first use; concurrent callers share the one attempt. */
    async client() {
        if (this.#closed)
            throw new Error(`MCP server "${this.name}" is closed`);
        if (this.#client !== undefined)
            return this.#client;
        if (this.#connecting === undefined) {
            this.#connecting = this.#connect().finally(() => {
                this.#connecting = undefined;
            });
        }
        return this.#connecting;
    }
    async #connect() {
        const client = new Client({ name: 'dsh-tool-aggregator', version: '0.5.0' });
        client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
            // The cached list is stale; whoever loaded this server re-syncs.
            this.#tools = undefined;
            this.#onListChanged?.();
        });
        try {
            await withTimeout(client.connect(this.#transport()), this.#connectTimeoutMs, `connect to MCP server "${this.name}"`);
        }
        catch (error) {
            await client.close().catch(() => { });
            throw new Error(`could not connect to MCP server "${this.name}": ${messageOf(error)}`);
        }
        this.#client = client;
        this.#logger.info(`[tool-aggregator] connected to MCP server "${this.name}"`);
        return client;
    }
    #transport() {
        if ((this.#config.transport ?? 'stdio') === 'streamable-http') {
            return new StreamableHTTPClientTransport(new URL(this.#config.url), {
                requestInit: { headers: this.#config.headers },
            });
        }
        return new StdioClientTransport({
            command: this.#config.command,
            args: this.#config.args ?? [],
            // Merge over the SDK default so a partial env map never drops PATH.
            env: { ...getDefaultEnvironment(), ...this.#config.env },
            cwd: this.#config.cwd,
        });
    }
    /**
     * The server's tool list, cached until a `list_changed` notification or a
     * forced refresh. Connects on first call.
     */
    async listTools(force = false) {
        if (this.#tools !== undefined && !force)
            return this.#tools;
        const client = await this.client();
        const discovered = [];
        const seen = new Set();
        let cursor;
        do {
            const page = await client.listTools(cursor === undefined ? undefined : { cursor });
            for (const tool of page.tools) {
                const publicName = publicToolName(this.name, tool.name);
                if (seen.has(publicName)) {
                    throw new Error(`MCP server "${this.name}" lists tool "${tool.name}" more than once; its tool list is invalid`);
                }
                seen.add(publicName);
                discovered.push({
                    rawName: tool.name,
                    publicName,
                    description: tool.description ?? '',
                    inputSchema: tool.inputSchema,
                });
            }
            cursor = page.nextCursor;
        } while (cursor !== undefined);
        this.#tools = discovered;
        return discovered;
    }
    /** Send one `tools/call` under the caller's cancellation and the call deadline. */
    async callTool(rawName, args, signal) {
        const client = await this.client();
        try {
            const result = await client.request({
                method: 'tools/call',
                params: {
                    name: rawName,
                    arguments: (typeof args === 'object' && args !== null ? args : {}),
                },
            }, RAW_CALL_RESULT_SCHEMA, { signal, timeout: this.#toolCallTimeoutMs });
            return result;
        }
        catch (error) {
            if (!signal.aborted) {
                // Transport-level failure: the client is unusable, so drop it and let
                // the next call reconnect rather than fail forever.
                this.#client = undefined;
                this.#tools = undefined;
                await client.close().catch(() => { });
                this.#logger.warn(`[tool-aggregator] MCP server "${this.name}" dropped after a failed call: ${messageOf(error)}`);
            }
            throw error;
        }
    }
    /** Register the single re-sync listener for this connection. */
    onToolsChanged(listener) {
        this.#onListChanged = listener;
    }
    /** Connection state without triggering a connection. */
    status() {
        return { connected: this.#client !== undefined, discovered: this.#tools?.length };
    }
    async close() {
        this.#closed = true;
        this.#onListChanged = undefined;
        const client = this.#client;
        this.#client = undefined;
        this.#tools = undefined;
        if (client !== undefined)
            await client.close().catch(() => { });
    }
}
/** One-line error text for logs and model-facing messages. */
export function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=connection.js.map