/**
 * One lazily-connected MCP server.
 *
 * The connection is created on first use (never at plugin load), shared by
 * every concurrent caller, and kept alive after `unload` so a re-load is
 * immediate. A transport-level failure drops the client so the next call
 * reconnects instead of failing forever. One user-visible operation (a loader
 * load, a tool call, a startup probe) draws from a single retry budget of
 * `reconnectAttempts + 1` connect+discovery attempts with bounded exponential
 * backoff (`reconnectAttempts` / `reconnectBackoffMs`); an idle server can be
 * soft-disconnected by the loader (`disconnect()`) and rebuilds on the next
 * load. Retry sleeps are interrupted by `close()`/`disconnect()`, so a
 * scheduled retry never spawns after teardown. A failed `tools/call` is never
 * retried or replayed.
 */
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
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
/** Default number of retries after a failed connect/discovery. */
export const DEFAULT_RECONNECT_ATTEMPTS = 1;
/** Default base delay before the first retry, in milliseconds. */
export const DEFAULT_RECONNECT_BACKOFF_MS = 500;
/** Backoff never exceeds this, whatever the exponent says. */
export const MAX_RETRY_BACKOFF_MS = 30_000;
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
export function isRetryable(error) {
    if (error instanceof McpError) {
        return error.code === ErrorCode.ConnectionClosed || error.code === ErrorCode.RequestTimeout;
    }
    return true;
}
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
    for (const field of ['reconnectAttempts', 'reconnectBackoffMs', 'idleDisconnectMs']) {
        const value = config[field];
        if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
            problems.push(`"${field}" must be a non-negative integer`);
        }
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
    #reconnectAttempts;
    #reconnectBackoffMs;
    #client;
    #connecting;
    #tools;
    #onListChanged;
    /** A client was dropped (failed call, disconnect) — the next connect is a rebuild. */
    #dropped = false;
    /** Bumped by `close()`/`disconnect()` to invalidate in-flight retry loops. */
    #retryEpoch = 0;
    /** The current retry backoff sleep, woken early by `#interruptRetry()`. */
    #retrySleep;
    #closed = false;
    constructor(name, config, logger, connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS) {
        this.name = name;
        this.#config = config;
        this.#logger = logger;
        this.#connectTimeoutMs = connectTimeoutMs;
        this.#toolCallTimeoutMs = config.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;
        this.#reconnectAttempts = config.reconnectAttempts ?? DEFAULT_RECONNECT_ATTEMPTS;
        this.#reconnectBackoffMs = config.reconnectBackoffMs ?? DEFAULT_RECONNECT_BACKOFF_MS;
    }
    /**
     * Connect on first use with the connection's retry budget; concurrent
     * callers share the one in-flight attempt. Only the *establish* is retried —
     * the tool-call path uses this, and the call itself is never retried.
     */
    async client() {
        return this.#retry((n) => this.#acquire(n));
    }
    /**
     * Return the current client, or share one in-flight connect attempt. Never
     * retries on its own: the caller's `#retry` loop owns the budget, so nested
     * loops cannot multiply the `reconnectAttempts` allowance.
     */
    async #acquire(n) {
        if (this.#closed)
            throw new Error(`MCP server "${this.name}" is closed`);
        if (this.#client !== undefined)
            return this.#client;
        if (this.#connecting === undefined) {
            this.#connecting = this.#connectOnce(n).finally(() => {
                this.#connecting = undefined;
            });
        }
        return this.#connecting;
    }
    /**
     * Run `attempt` up to `reconnectAttempts + 1` times — one shared budget for
     * whichever user-visible operation called it (a loader load, a tool call, a
     * startup probe) — sleeping `reconnectBackoffMs × 2^n` between tries.
     * Failures that {@link isRetryable} rejects as non-transient abort
     * immediately; the last error is rethrown when the budget is exhausted.
     *
     * Every round starts and ends with a liveness check: once {@link close} or
     * {@link disconnect} has run, a sleeping retry is woken and the loop exits
     * without spawning again, so teardown and idle disconnect never leave a
     * scheduled spawn behind.
     */
    async #retry(attempt) {
        const tries = 1 + Math.max(0, this.#reconnectAttempts);
        const epoch = this.#retryEpoch;
        let lastError;
        for (let n = 0; n < tries; n++) {
            this.#throwIfRetrySuperseded(epoch);
            try {
                return await attempt(n);
            }
            catch (error) {
                lastError = error;
                if (!isRetryable(error) || n + 1 >= tries)
                    break;
                this.#throwIfRetrySuperseded(epoch);
                await this.#backoffSleep(Math.min(this.#reconnectBackoffMs * 2 ** n, MAX_RETRY_BACKOFF_MS));
            }
        }
        throw lastError;
    }
    /** Throw when close/disconnect superseded this retry loop at a round boundary. */
    #throwIfRetrySuperseded(epoch) {
        if (this.#closed || epoch !== this.#retryEpoch) {
            throw new Error(`MCP server "${this.name}" ${this.#closed ? 'is closed' : 'was disconnected'}; retries cancelled`);
        }
    }
    /** Backoff sleep that {@link #interruptRetry} wakes early. */
    #backoffSleep(ms) {
        return new Promise((resolve) => {
            const wake = () => resolve();
            const timer = setTimeout(() => {
                if (this.#retrySleep?.wake === wake)
                    this.#retrySleep = undefined;
                resolve();
            }, ms);
            this.#retrySleep = { timer, wake };
        });
    }
    /** Wake a sleeping retry and invalidate every in-flight retry loop. */
    #interruptRetry() {
        this.#retryEpoch += 1;
        const sleep = this.#retrySleep;
        this.#retrySleep = undefined;
        if (sleep !== undefined) {
            clearTimeout(sleep.timer);
            sleep.wake();
        }
    }
    /**
     * Establish one connection. A failed attempt closes its own transport, so it
     * is never reusable; retrying here is safe because no request has been sent
     * yet — tools/call is never replayed anywhere. `n` is the attempt ordinal of
     * the enclosing retry loop, used only for the log line.
     */
    async #connectOnce(n) {
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
        const rebuilt = this.#dropped || n > 0;
        this.#dropped = false;
        this.#logger.info(rebuilt
            ? `[tool-aggregator] MCP server "${this.name}" client rebuilt (attempt ${n + 1})`
            : `[tool-aggregator] connected to MCP server "${this.name}"`);
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
     *
     * One retry unit is a full connect + discovery, and the operation draws from
     * the single `reconnectAttempts + 1` budget — a load, probe or resync never
     * multiplies its allowance across an inner connect retry. A mid-discovery
     * failure drops the client (it may be half-dead), so the next attempt — and
     * every later call — starts from a fresh connection.
     */
    async listTools(force = false) {
        if (this.#tools !== undefined && !force)
            return this.#tools;
        return this.#retry(async (n) => {
            const client = await this.#acquire(n);
            try {
                const discovered = await this.#discover(client);
                this.#tools = discovered;
                return discovered;
            }
            catch (error) {
                // A failure after a successful connect leaves the client in an unknown
                // state. Drop it so the retry — and every later call — reconnects;
                // deterministic failures still surface (after invalidation) when the
                // retry budget is exhausted or the error is non-transient.
                this.#tools = undefined;
                if (isRetryable(error)) {
                    this.#client = undefined;
                    this.#dropped = true;
                    await client.close().catch(() => { });
                }
                throw error;
            }
        });
    }
    async #discover(client) {
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
                // the next call reconnect rather than fail forever. The call itself is
                // never replayed — its side effects are unknown.
                this.#client = undefined;
                this.#tools = undefined;
                this.#dropped = true;
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
    /**
     * Soft disconnect: close the current client (and any in-flight connect) and
     * drop the cached state, but keep this connection reusable.
     *
     * Unlike {@link close}, this does not set the closed flag and keeps the
     * list_changed listener, so the next `client()` / `listTools()` reconnects
     * lazily — used by the idle-disconnect timer in the loader, which must be
     * able to rebuild the connection on the next load.
     */
    async disconnect() {
        this.#dropped = true;
        // Cancel any scheduled retry first: a sleeping retry must not wake up and
        // spawn a fresh child that undoes this disconnect.
        this.#interruptRetry();
        const connecting = this.#connecting;
        this.#connecting = undefined;
        if (connecting !== undefined) {
            try {
                // Settle the in-flight attempt so it cannot leave a client behind; a
                // failed attempt already closed its own transport.
                await connecting;
            }
            catch {
                // Ignore: the attempt's error is not this caller's to report.
            }
        }
        const client = this.#client;
        this.#client = undefined;
        this.#tools = undefined;
        if (client !== undefined)
            await client.close().catch(() => { });
    }
    async close() {
        this.#closed = true;
        this.#onListChanged = undefined;
        // Interrupt any retry that is sleeping between attempts so plugin teardown
        // never triggers another spawn.
        this.#interruptRetry();
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