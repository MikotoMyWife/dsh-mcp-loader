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
import { createHash } from 'node:crypto'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import {
  Client,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
  type StandardSchemaV1,
} from '@modelcontextprotocol/client'
import { childEnv } from './env.js'
import type { DiscoveredTool, ServerConfig } from './types.js'

/** DeepSeek function-name contract: at most 64 characters. */
const MAX_PUBLIC_NAME_LENGTH = 64
/** DeepSeek function-name contract: only `[A-Za-z0-9_-]` is allowed. */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
/** Hex chars of the SHA-256 identity hash appended on lossy normalization. */
const HASH_LENGTH = 12
/** Default per-`tools/call` deadline. */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000
/** Default connection handshake deadline. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000
/** Default number of retries after a failed connect/discovery. */
export const DEFAULT_RECONNECT_ATTEMPTS = 1
/** Default base delay before the first retry, in milliseconds. */
export const DEFAULT_RECONNECT_BACKOFF_MS = 500
/** Backoff never exceeds this, whatever the exponent says. */
export const MAX_RETRY_BACKOFF_MS = 30_000
/** Default discovery hard cap: pages of `tools/list` per real discovery. */
export const DEFAULT_MAX_TOOL_LIST_PAGES = 100
/** Default discovery hard cap: raw tools one server may expose. */
export const DEFAULT_MAX_TOOLS_PER_SERVER = 500
/** Default discovery deadline for one real pagination, in milliseconds. */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 60_000
/** Default deadline for confirming that a transport really closed. */
export const DEFAULT_CLOSE_TIMEOUT_MS = 5_000
/** Default ceiling for one server's MCP instructions, in UTF-8 bytes. */
export const DEFAULT_MAX_INSTRUCTION_BYTES = 32_768

/** Which discovery hard cap was hit. */
export type DiscoveryLimitReason = 'pages' | 'tools' | 'timeout'

/**
 * A deterministic discovery hard cap was exceeded (or the discovery deadline
 * passed). The loader never retries these: retrying cannot shrink a server's
 * catalogue, and a server that does not answer in time rarely will on a second
 * try. The message names the server and the reason so operators can raise the
 * right cap.
 */
export class DiscoveryLimitError extends Error {
  readonly reason: DiscoveryLimitReason
  constructor(serverName: string, reason: DiscoveryLimitReason, limit: number) {
    const detail =
      reason === 'pages'
        ? `discovery page limit of ${limit} pages exceeded (maxToolListPages)`
        : reason === 'tools'
          ? `discovery tool limit of ${limit} tools exceeded (maxToolsPerServer)`
          : `discovery timeout of ${limit}ms exceeded (discoveryTimeoutMs)`
    super(`MCP server "${serverName}" ${detail}`)
    this.name = 'DiscoveryLimitError'
    this.reason = reason
  }
}

/**
 * A teardown could not confirm that the server's transport closed, so this
 * connection refuses to reconnect: the child process may still be alive and a
 * fresh connect would start a second one for the same server. Only a plugin (or
 * session) restart clears this — deliberately not retryable, because retrying is
 * exactly what would create the overlapping process.
 */
export class UnconfirmedCloseError extends Error {
  constructor(serverName: string) {
    super(
      `MCP server "${serverName}" was closed but its transport closure could not be confirmed; `
      + 'refusing to reconnect to avoid overlapping server processes (restart the plugin or session to retry)',
    )
    this.name = 'UnconfirmedCloseError'
  }
}

/**
 * A server's MCP instructions exceeded `maxInstructionBytes`.
 *
 * Deterministic, so never retried: a server that sends an over-long instruction
 * block will send it again. Surfacing the load failure (instead of truncating)
 * follows the plugin's cap discipline — a silent cut would hand the model a
 * half-sentence and hide the operator's missing configuration.
 */
export class InstructionLimitError extends Error {
  constructor(serverName: string, limit: number, actual: number) {
    super(
      `MCP server "${serverName}" sent ${actual} bytes of instructions, over the maxInstructionBytes limit of ${limit} bytes`,
    )
    this.name = 'InstructionLimitError'
  }
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
export function isRetryable(error: unknown): boolean {
  if (error instanceof DiscoveryLimitError) return false
  if (error instanceof InstructionLimitError) return false
  if (error instanceof UnconfirmedCloseError) return false
  if (error instanceof SdkError) {
    return error.code === SdkErrorCode.ConnectionClosed || error.code === SdkErrorCode.RequestTimeout
  }
  if (error instanceof ProtocolError) return false
  return true
}

/**
 * Result schema that accepts any `tools/call` result shape.
 *
 * `Client.callTool` additionally validates `structuredContent` against the
 * tool's declared `outputSchema` and throws `-32602` when a server returns extra
 * properties — inkstone's `search` does exactly that. This bridge owns no output
 * contract, so it issues the raw request and skips that per-tool validator, the
 * same way `@deepseek-ai/dsh-mcp-client` does.
 *
 * The schema must be a Standard Schema v1: `request()` treats a second argument
 * that is not one as absent and silently falls back to the spec's method-keyed
 * `CallToolResult` validator. The explicit type annotation keeps the request's
 * return type informative (`unknown`) instead of collapsing to `never`.
 */
const RAW_CALL_RESULT_SCHEMA: StandardSchemaV1<unknown, unknown> = {
  '~standard': {
    version: 1,
    vendor: 'dsh-mcp-loader',
    validate: (value: unknown) => ({ value }),
  },
}

/** One raw `tools/list` page, exactly as the server sent it. */
interface ListToolsPage {
  tools: Array<{ name: string; description?: string; inputSchema: unknown }>
  nextCursor?: string
}

/**
 * Result schema for one raw `tools/list` page.
 *
 * Discovery paginates by hand — the page count is a configured hard cap
 * (`maxToolListPages`), so the SDK must not aggregate pages behind our back:
 * `Client.listTools` without an explicit cursor walks every page itself (capped
 * by its own `listMaxPages`) and caches the result, which would take the page
 * accounting out of our hands and add a second cache beside `#tools`.
 */
const RAW_LIST_TOOLS_RESULT_SCHEMA: StandardSchemaV1<unknown, ListToolsPage> = {
  '~standard': {
    version: 1,
    vendor: 'dsh-mcp-loader',
    validate: (value: unknown) => ({ value: value as ListToolsPage }),
  },
}

/** The logging surface the plugin needs; Cordis supplies it, tests may not. */
export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** One MCP resource operation this bridge can proxy, with server-owned cursors and URIs. */
export type McpResourceRequest =
  | { method: 'resources/list' | 'resources/templates/list'; cursor?: string }
  | { method: 'resources/read'; uri: string }

/**
 * Result schema for one raw resource request.
 *
 * The resource runtime owns the model-facing shape; this bridge only carries the
 * protocol answer across, so the schema accepts any JSON result — the same
 * stance as raw `tools/call`.
 */
const RAW_RESOURCE_RESULT_SCHEMA: StandardSchemaV1<unknown, unknown> = {
  '~standard': {
    version: 1,
    vendor: 'dsh-mcp-loader',
    validate: (value: unknown) => ({ value }),
  },
}

/** The subset of an MCP `tools/call` result this plugin reads. */
export interface McpCallResult {
  content?: unknown
  structuredContent?: unknown
  isError?: boolean
}

/** Connection state reported without forcing a connection. */
export interface ConnectionStatus {
  connected: boolean
  /** Cached tool count, or `undefined` when the tool list was never fetched. */
  discovered: number | undefined
}

/**
 * Derive the model-facing public name for one MCP tool.
 *
 * The clean case is `mcp__<serverName>__<rawName>` verbatim. When character
 * replacement or truncation changes the name, a 12-hex-char SHA-256 hash of the
 * identity is appended so distinct MCP identities never collapse into one name.
 * Mirrors `@deepseek-ai/dsh-mcp-client` so both bridges agree on naming.
 */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

/** Collect every configuration problem for one server entry, in report order. */
export function validateServerConfig(name: string, config: ServerConfig): string[] {
  const problems: string[] = []
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) problems.push('server name must match [A-Za-z0-9_-]{1,32}')
  const transport = config.transport ?? 'stdio'
  if (transport === 'stdio') {
    if (typeof config.command !== 'string' || config.command.length === 0) {
      problems.push('stdio transport requires a non-empty "command"')
    }
    if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some((arg) => typeof arg !== 'string'))) {
      problems.push('"args" must be an array of strings')
    }
  } else if (transport === 'streamable-http') {
    if (typeof config.url !== 'string' || config.url.length === 0) {
      problems.push('streamable-http transport requires a non-empty "url"')
    }
  } else {
    problems.push(`unknown transport ${JSON.stringify(config.transport)}; expected "stdio" or "streamable-http"`)
  }
  if (config.toolCallTimeoutMs !== undefined
    && (!Number.isFinite(config.toolCallTimeoutMs) || config.toolCallTimeoutMs <= 0)) {
    problems.push('"toolCallTimeoutMs" must be a positive finite number')
  }
  for (const field of ['reconnectAttempts', 'reconnectBackoffMs', 'idleDisconnectMs'] as const) {
    const value = config[field]
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      problems.push(`"${field}" must be a non-negative integer`)
    }
  }
  for (const field of ['maxToolListPages', 'maxToolsPerServer', 'discoveryTimeoutMs', 'closeTimeoutMs', 'maxInstructionBytes'] as const) {
    const value = config[field]
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      problems.push(`"${field}" must be a positive integer`)
    }
  }
  return problems
}

/** Reject after `ms` when `promise` has not settled. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string, onTimeout?: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout ? onTimeout() : new Error(`timed out after ${ms}ms: ${what}`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/** The transport type `Client.connect` accepts. */
type TransportLike = Parameters<Client['connect']>[0]

/** Construction options for one {@link ServerConnection}. */
export interface ServerConnectionOptions {
  /** Connection handshake deadline in milliseconds. */
  connectTimeoutMs?: number
  /**
   * Test seam: build the transport for this connection. Defaults to stdio or
   * streamable-http per config. A transport whose `close()` never settles cannot
   * be produced with a real stdio child on Windows (Node terminates the process
   * outright), so the close barrier is verified through this seam.
   */
  transportFactory?: (name: string, config: ServerConfig) => TransportLike
}

export class ServerConnection {
  readonly name: string
  #config: ServerConfig
  #logger: Logger
  #connectTimeoutMs: number
  #toolCallTimeoutMs: number
  #reconnectAttempts: number
  #reconnectBackoffMs: number
  #maxToolListPages: number
  #maxToolsPerServer: number
  #discoveryTimeoutMs: number
  #closeTimeoutMs: number
  #transportFactory: ServerConnectionOptions['transportFactory']
  #client: Client | undefined
  #connecting: Promise<Client> | undefined
  #tools: DiscoveredTool[] | undefined
  #onListChanged: (() => void) | undefined
  /** A client was dropped (failed call, disconnect) — the next connect is a rebuild. */
  #dropped = false
  /** Bumped by `close()`/`disconnect()` to invalidate in-flight retry loops. */
  #retryEpoch = 0
  /** The current retry backoff sleep, woken early by `#interruptRetry()`. */
  #retrySleep: { timer: NodeJS.Timeout; wake: () => void } | undefined
  #closed = false
  /**
   * A close was not confirmed in time, so the child may still be alive. Set by
   * {@link #closeGeneration}; from then on this connection refuses to connect
   * again instead of overlapping server processes.
   */
  #closureUnconfirmed = false
  /** Whether the "no tools capability" notice was already logged for this client. */
  #noToolsCapabilityLogged = false
  #maxInstructionBytes: number
  /** The connected server's own instructions, trimmed; `undefined` when it sent none. */
  #instructions: string | undefined

  constructor(name: string, config: ServerConfig, logger: Logger, options: ServerConnectionOptions = {}) {
    this.name = name
    this.#config = config
    this.#logger = logger
    this.#connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.#transportFactory = options.transportFactory
    this.#toolCallTimeoutMs = config.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS
    this.#reconnectAttempts = config.reconnectAttempts ?? DEFAULT_RECONNECT_ATTEMPTS
    this.#reconnectBackoffMs = config.reconnectBackoffMs ?? DEFAULT_RECONNECT_BACKOFF_MS
    this.#maxToolListPages = config.maxToolListPages ?? DEFAULT_MAX_TOOL_LIST_PAGES
    this.#maxToolsPerServer = config.maxToolsPerServer ?? DEFAULT_MAX_TOOLS_PER_SERVER
    this.#discoveryTimeoutMs = config.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS
    this.#closeTimeoutMs = config.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS
    this.#maxInstructionBytes = config.maxInstructionBytes ?? DEFAULT_MAX_INSTRUCTION_BYTES
  }

  /**
   * Connect on first use with the connection's retry budget; concurrent
   * callers share the one in-flight attempt. Only the *establish* is retried —
   * the tool-call path uses this, and the call itself is never retried.
   */
  async client(): Promise<Client> {
    return this.#retry((n) => this.#acquire(n))
  }

  /**
   * Return the current client, or share one in-flight connect attempt. Never
   * retries on its own: the caller's `#retry` loop owns the budget, so nested
   * loops cannot multiply the `reconnectAttempts` allowance.
   */
  async #acquire(n: number): Promise<Client> {
    if (this.#closed) throw new Error(`MCP server "${this.name}" is closed`)
    if (this.#closureUnconfirmed) throw new UnconfirmedCloseError(this.name)
    if (this.#client !== undefined) return this.#client
    if (this.#connecting === undefined) {
      this.#connecting = this.#connectOnce(n).finally(() => {
        this.#connecting = undefined
      })
    }
    return this.#connecting
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
  async #retry<T>(attempt: (n: number) => Promise<T>): Promise<T> {
    const tries = 1 + Math.max(0, this.#reconnectAttempts)
    const epoch = this.#retryEpoch
    let lastError: unknown
    for (let n = 0; n < tries; n++) {
      this.#throwIfRetrySuperseded(epoch)
      try {
        return await attempt(n)
      } catch (error) {
        lastError = error
        if (!isRetryable(error) || n + 1 >= tries) break
        this.#throwIfRetrySuperseded(epoch)
        await this.#backoffSleep(Math.min(this.#reconnectBackoffMs * 2 ** n, MAX_RETRY_BACKOFF_MS))
      }
    }
    throw lastError
  }

  /** Throw when close/disconnect superseded this retry loop at a round boundary. */
  #throwIfRetrySuperseded(epoch: number): void {
    if (this.#closed || epoch !== this.#retryEpoch) {
      throw new Error(`MCP server "${this.name}" ${this.#closed ? 'is closed' : 'was disconnected'}; retries cancelled`)
    }
  }

  /** Backoff sleep that {@link #interruptRetry} wakes early. */
  #backoffSleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const wake = () => resolve()
      const timer = setTimeout(() => {
        if (this.#retrySleep?.wake === wake) this.#retrySleep = undefined
        resolve()
      }, ms)
      this.#retrySleep = { timer, wake }
    })
  }

  /** Wake a sleeping retry and invalidate every in-flight retry loop. */
  #interruptRetry(): void {
    this.#retryEpoch += 1
    const sleep = this.#retrySleep
    this.#retrySleep = undefined
    if (sleep !== undefined) {
      clearTimeout(sleep.timer)
      sleep.wake()
    }
  }

  /**
   * Close one client generation and confirm that the transport really closed,
   * bounded by `closeTimeoutMs`.
   *
   * A closing transport that does not settle in time (a child that ignores
   * shutdown, a half-open HTTP stream) leaves the server possibly alive, so the
   * connection is poisoned and refuses to reconnect — mirroring the disposal
   * barrier `@deepseek-ai/dsh-mcp-client` added in 0.1.6, whose stated risk is
   * exactly an overlapping server process. A rejected `close()` is treated as
   * unconfirmed for the same reason: nothing proved the child is gone.
   *
   * @returns whether closure was confirmed.
   */
  async #closeGeneration(client: Client, context: string): Promise<boolean> {
    let failure: unknown
    let timer: NodeJS.Timeout | undefined
    const closed = client.close().then(
      () => true,
      (error: unknown) => {
        failure = error
        return false
      },
    )
    const confirmed = await Promise.race([
      closed,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), this.#closeTimeoutMs)
      }),
    ])
    if (timer !== undefined) clearTimeout(timer)
    if (!confirmed) {
      this.#closureUnconfirmed = true
      const detail = failure === undefined
        ? `no confirmation within ${this.#closeTimeoutMs}ms`
        : `close failed: ${messageOf(failure)}`
      this.#logger.warn(
        `[tool-aggregator] MCP server "${this.name}" (${context}): transport closure could not be confirmed (${detail}) `
        + '— server shutdown may be incomplete; refusing to reconnect to avoid overlapping server processes',
      )
    }
    return confirmed
  }

  /**
   * Establish one connection. A failed attempt closes its own transport, so it
   * is never reusable; retrying here is safe because no request has been sent
   * yet — tools/call is never replayed anywhere. `n` is the attempt ordinal of
   * the enclosing retry loop, used only for the log line.
   */
  async #connectOnce(n: number): Promise<Client> {
    const client = new Client({ name: 'dsh-tool-aggregator', version: '0.5.0' })
    client.setNotificationHandler('notifications/tools/list_changed', () => {
      // The cached list is stale; whoever loaded this server re-syncs.
      this.#tools = undefined
      this.#onListChanged?.()
    })
    try {
      await withTimeout(client.connect(this.#transport()), this.#connectTimeoutMs, `connect to MCP server "${this.name}"`)
    } catch (error) {
      await this.#closeGeneration(client, 'failed connect')
      throw new Error(`could not connect to MCP server "${this.name}": ${messageOf(error)}`)
    }
    // The server's own instructions arrive with the handshake. Enforce the byte
    // ceiling here, before the connection is published, so an over-long block
    // fails this load instead of quietly entering a model-facing result.
    const instructions = client.getInstructions()?.trimEnd()
    if (instructions !== undefined && instructions.length > 0) {
      const bytes = Buffer.byteLength(instructions, 'utf8')
      if (bytes > this.#maxInstructionBytes) {
        await this.#closeGeneration(client, 'over-long instructions')
        throw new InstructionLimitError(this.name, this.#maxInstructionBytes, bytes)
      }
      this.#instructions = instructions
    } else {
      this.#instructions = undefined
    }
    this.#client = client
    const rebuilt = this.#dropped || n > 0
    this.#dropped = false
    this.#noToolsCapabilityLogged = false
    this.#logger.info(
      rebuilt
        ? `[tool-aggregator] MCP server "${this.name}" client rebuilt (attempt ${n + 1})`
        : `[tool-aggregator] connected to MCP server "${this.name}"`,
    )
    return client
  }

  #transport(): TransportLike {
    if (this.#transportFactory !== undefined) return this.#transportFactory(this.name, this.#config)
    if ((this.#config.transport ?? 'stdio') === 'streamable-http') {
      return new StreamableHTTPClientTransport(new URL(this.#config.url as string), {
        requestInit: { headers: this.#config.headers },
      })
    }
    return new StdioClientTransport({
      command: this.#config.command as string,
      args: this.#config.args ?? [],
      // The scrubbed parent environment (never the SDK's minimal default): a
      // server started through npx needs PATH, NPM_CONFIG_* and the proxy
      // variables, while credentials and DSH_* facts are withheld.
      env: childEnv(this.#config.env),
      cwd: this.#config.cwd,
    })
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
  async listTools(force = false): Promise<DiscoveredTool[]> {
    if (this.#tools !== undefined && !force) return this.#tools
    return this.#retry(async (n) => {
      const client = await this.#acquire(n)
      try {
        const discovered = await this.#discover(client)
        this.#tools = discovered
        return discovered
      } catch (error) {
        // A failure after a successful connect leaves the client in an unknown
        // state. Drop it so the retry — and every later call — reconnects;
        // deterministic failures still surface (after invalidation) when the
        // retry budget is exhausted or the error is non-transient. A discovery
        // deadline expiry can leave a page request hanging on a slow server, so
        // it also drops the client — a later call must reconnect rather than
        // queue behind the stale request. (Page/tool caps follow a complete
        // answer and keep the healthy client.)
        this.#tools = undefined
        if (isRetryable(error) || (error instanceof DiscoveryLimitError && error.reason === 'timeout')) {
          this.#client = undefined
          this.#dropped = true
          await this.#closeGeneration(client, 'failed discovery')
        }
        throw error
      }
    })
  }

  /**
   * Fetch one server's full tool list over the real network, bounded by the
   * discovery caps: at most `maxToolListPages` pages, at most
   * `maxToolsPerServer` raw tools, and an overall `discoveryTimeoutMs`
   * deadline around the pagination. Exceeding any cap throws a
   * {@link DiscoveryLimitError} naming the server and the reason.
   */
  async #discover(client: Client): Promise<DiscoveredTool[]> {
    // A server that never declared the tools capability has no tool list to
    // offer. Treating that as an empty catalogue (instead of failing the load)
    // keeps resources-only and prompts-only servers from erroring on every
    // load, and matches the official bridge's disposition. Logged once per
    // connection so a later re-sync stays quiet.
    if (client.getServerCapabilities()?.tools === undefined) {
      if (!this.#noToolsCapabilityLogged) {
        this.#noToolsCapabilityLogged = true
        this.#logger.info(
          `[tool-aggregator] MCP server "${this.name}" declares no tools capability; its tool list is treated as empty`,
        )
      }
      return []
    }
    const discovered: DiscoveredTool[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    let pages = 0
    await withTimeout(
      (async () => {
        do {
          pages += 1
          if (pages > this.#maxToolListPages) {
            throw new DiscoveryLimitError(this.name, 'pages', this.#maxToolListPages)
          }
          const page = await client.request(
            { method: 'tools/list', params: cursor === undefined ? {} : { cursor } },
            RAW_LIST_TOOLS_RESULT_SCHEMA,
          )
          for (const tool of page.tools) {
            const publicName = publicToolName(this.name, tool.name)
            if (seen.has(publicName)) {
              throw new Error(`MCP server "${this.name}" lists tool "${tool.name}" more than once; its tool list is invalid`)
            }
            seen.add(publicName)
            discovered.push({
              rawName: tool.name,
              publicName,
              description: tool.description ?? '',
              inputSchema: tool.inputSchema,
            })
          }
          if (discovered.length > this.#maxToolsPerServer) {
            throw new DiscoveryLimitError(this.name, 'tools', this.#maxToolsPerServer)
          }
          cursor = page.nextCursor
        } while (cursor !== undefined)
      })(),
      this.#discoveryTimeoutMs,
      `discovering tools of MCP server "${this.name}"`,
      () => new DiscoveryLimitError(this.name, 'timeout', this.#discoveryTimeoutMs),
    )
    return discovered
  }

  /** Send one `tools/call` under the caller's cancellation and the call deadline. */
  async callTool(rawName: string, args: unknown, signal: AbortSignal): Promise<McpCallResult> {    const client = await this.client()
    try {
      const result = await client.request(
        {
          method: 'tools/call',
          params: {
            name: rawName,
            arguments: (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>,
          },
        },
        RAW_CALL_RESULT_SCHEMA,
        { signal, timeout: this.#toolCallTimeoutMs },
      )
      return result as unknown as McpCallResult
    } catch (error) {
      if (!signal.aborted) {
        // Transport-level failure: the client is unusable, so drop it and let
        // the next call reconnect rather than fail forever. The call itself is
        // never replayed — its side effects are unknown.
        this.#client = undefined
        this.#tools = undefined
        this.#dropped = true
        await this.#closeGeneration(client, 'failed call')
        this.#logger.warn(`[tool-aggregator] MCP server "${this.name}" dropped after a failed call: ${messageOf(error)}`)
      }
      throw error
    }
  }

  /**
   * Proxy one MCP resource operation over the live connection.
   *
   * The result is handed back as it arrived (`unknown`): the resource runtime
   * that consumes it owns the model-facing shape, exactly as with `tools/call`.
   * A transport-level failure drops the client the same way a failed call does —
   * a resource read is equally unrepeatable from our side.
   */
  async requestResources(request: McpResourceRequest, signal: AbortSignal): Promise<unknown> {
    const client = await this.client()
    try {
      const params =
        request.method === 'resources/read'
          ? { uri: request.uri }
          : request.cursor === undefined
            ? {}
            : { cursor: request.cursor }
      return await client.request(
        { method: request.method, params },
        RAW_RESOURCE_RESULT_SCHEMA,
        { signal, timeout: this.#toolCallTimeoutMs },
      )
    } catch (error) {
      if (!signal.aborted) {
        this.#client = undefined
        this.#tools = undefined
        this.#dropped = true
        await this.#closeGeneration(client, 'failed resource request')
        this.#logger.warn(
          `[tool-aggregator] MCP server "${this.name}" dropped after a failed ${request.method}: ${messageOf(error)}`,
        )
      }
      throw error
    }
  }

  /** Register the single re-sync listener for this connection. */
  onToolsChanged(listener: () => void): void {
    this.#onListChanged = listener
  }

  /** Connection state without triggering a connection. */
  status(): ConnectionStatus {
    return { connected: this.#client !== undefined, discovered: this.#tools?.length }
  }

  /**
   * The connected server's MCP instructions, or `undefined` when it sent none —
   * or when no client is live, so a dropped connection never reports a stale
   * instruction block.
   */
  instructions(): string | undefined {
    return this.#client === undefined ? undefined : this.#instructions
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
  async disconnect(): Promise<void> {
    this.#dropped = true
    // Cancel any scheduled retry first: a sleeping retry must not wake up and
    // spawn a fresh child that undoes this disconnect.
    this.#interruptRetry()
    const connecting = this.#connecting
    this.#connecting = undefined
    if (connecting !== undefined) {
      try {
        // Settle the in-flight attempt so it cannot leave a client behind; a
        // failed attempt already closed its own transport.
        await connecting
      } catch {
        // Ignore: the attempt's error is not this caller's to report.
      }
    }
    const client = this.#client
    this.#client = undefined
    this.#tools = undefined
    if (client !== undefined) await this.#closeGeneration(client, 'idle disconnect')
  }

  /**
   * Permanent teardown: close the current client and refuse further use.
   *
   * Bounded by `closeTimeoutMs` — if the transport will not confirm closure the
   * connection logs it and is poisoned, so teardown can never hang forever on a
   * server that ignores shutdown.
   */
  async close(): Promise<void> {
    this.#closed = true
    this.#onListChanged = undefined
    // Interrupt any retry that is sleeping between attempts so plugin teardown
    // never triggers another spawn.
    this.#interruptRetry()
    const client = this.#client
    this.#client = undefined
    this.#tools = undefined
    if (client !== undefined) await this.#closeGeneration(client, 'plugin teardown')
  }
}

/** One-line error text for logs and model-facing messages. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
