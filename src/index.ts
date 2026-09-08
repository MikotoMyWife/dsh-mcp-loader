/**
 * Lazy-loading MCP tools for the DeepSeek Harness.
 *
 * Instead of registering every MCP tool at startup, this plugin registers one
 * loader tool per multi-tool server (default name `mcp_<server>`). The loader's
 * description is the server's own description plus a hint, and calling it
 * registers that server's real tools — which therefore appear in the model's
 * tool list on its next step of the same turn.
 *
 * A server exposing at most `singleToolThreshold` tools (default 1) is not worth
 * a loader: it is registered eagerly, exactly as `dsh-mcp-client` would.
 *
 * Registration is deployment-wide, matching `dsh-mcp-client`. That is deliberate:
 * per-agent `ctx.tools.restrict()` filters only *inherited* tools and rejects
 * names that are not globally registered, so composition plugins that hide tools
 * per agent (e.g. inkstone-tool-hide) can only work against global
 * registrations.
 */
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ServerConnection, messageOf, validateServerConfig, type Logger } from './connection.js'
import { PRESET_PARAMETER_DESCRIPTION_CAP, descriptionOverridesFor } from './presets.js'
import type { DiscoveredTool, PluginConfig, ServerConfig } from './types.js'

/** Appended to every loader tool description unless overridden by config. */
const DEFAULT_LOADER_HINT = "Call to load this MCP server's tools; call again to hide them."

/** Loader metadata: the plugin owns no service, but it must not apply before the registry. */
export const name = 'tool-aggregator'
/** Cordis dependency: the tool registry must exist before this plugin applies. */
export const inject = ['tools']

/** Whether a rule string contains glob metacharacters. */
function isGlobRule(rule: string): boolean {
  return rule.includes('*') || rule.includes('?')
}

/** Default loader tool name for a server that does not set `loaderName`. */
const loaderNameDefault = (serverName: string): string => `mcp_${serverName}`

/** Compile a tool rule to an anchored matcher: `*` any run, `?` one char, the rest literal. */
function ruleToRegExp(rule: string): RegExp {
  let source = ''
  for (const char of rule) {
    if (char === '*') source += '.*'
    else if (char === '?') source += '.'
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

/**
 * Expand a server's {@link ServerConfig.hiddenTools} rules against its
 * discovered tool set into the deny list (matched public names, deduplicated).
 * A raw-name rule is anchored against `rawName`; a public rule (starting with
 * `mcp__`) against `publicName`. Exact raw/full names keep their v0.5.0
 * meaning; glob rules `*`/`?` expand to everything they match.
 *
 * The server's own loader tool is never denied: an exact rule textually equal
 * to the loader name is rejected at mount time (never reaches load), and any
 * rule whose pattern would also cover the loader name is reported through
 * `loaderHit` so the caller can drop the loader defensively and warn once.
 */
function expandToolRules(
  serverName: string,
  config: ServerConfig,
  discovered: DiscoveredTool[],
): { deny: string[]; loaderHit: boolean } {
  const loaderName = config.loaderName ?? loaderNameDefault(serverName)
  const deny = new Set<string>()
  let loaderHit = false
  for (const rule of config.hiddenTools ?? []) {
    const matcher = ruleToRegExp(rule)
    const publicRule = rule.startsWith('mcp__')
    for (const tool of discovered) {
      if (matcher.test(publicRule ? tool.publicName : tool.rawName)) deny.add(tool.publicName)
    }
    // The loader tool is registered globally and visible per agent, so a
    // pattern that covers its name must never reach an agent's deny mask.
    if (matcher.test(loaderName)) loaderHit = true
  }
  deny.delete(loaderName)
  return { deny: [...deny], loaderHit }
}

/** The registry surface this plugin needs from `ctx.tools`. */
interface ToolRegistrar {
  register(definition: ToolDefinition): () => void
}

export function apply(ctx: any, config: PluginConfig = {}): void {
  const serverConfigs: Record<string, ServerConfig> = config.servers ?? {}
  const loaderHint = config.loaderHint ?? DEFAULT_LOADER_HINT
  const singleToolThreshold = config.singleToolThreshold ?? 1
  const probeAtStartup = config.probeAtStartup ?? true

  if (!Number.isInteger(singleToolThreshold) || singleToolThreshold < 0) {
    throw new Error('tool-aggregator: "singleToolThreshold" must be a non-negative integer')
  }

  const logger: Logger = {
    info: (message) => ctx.logger?.info?.(message),
    warn: (message) => ctx.logger?.warn?.(message),
    error: (message) => ctx.logger?.error?.(message),
  }

  for (const [serverName, serverConfig] of Object.entries(serverConfigs)) {
    const problems = validateServerConfig(serverName, serverConfig)
    // Lockout protection, statically decidable: a hiddenTools/disabledTools
    // rule that textually equals this server's own loader tool name would hide
    // or disable the toggle every agent uses to reach the server. Fail fast by
    // naming the loader instead of waiting for a load.
    const loaderName = serverConfig.loaderName ?? loaderNameDefault(serverName)
    for (const field of ['hiddenTools', 'disabledTools'] as const) {
      for (const rule of serverConfig[field] ?? []) {
        if (typeof rule !== 'string') {
          problems.push(`"${field}" entry must be a string, got ${typeof rule}`)
          continue
        }
        if (!isGlobRule(rule) && rule === loaderName) {
          problems.push(
            `"${field}" rule "${rule}" equals this server's loader name "${loaderName}"; rename the loader or drop the rule`,
          )
        }
      }
    }
    if (problems.length > 0) throw new Error(`tool-aggregator: server "${serverName}": ${problems.join('; ')}`)
    // Fail fast on an unknown description preset instead of at first load.
    descriptionOverridesFor(serverConfig)
  }

  const found = ctx.get('tools') as ToolRegistrar | undefined
  if (found === undefined) {
    throw new Error('tool-aggregator requires @deepseek-ai/dsh-tools (ctx.tools) in the composition')
  }
  /** Non-optional binding so closures see the narrowed type. */
  const registry: ToolRegistrar = found

  const connections = new Map<string, ServerConnection>()
  for (const [serverName, serverConfig] of Object.entries(serverConfigs)) {
    connections.set(serverName, new ServerConnection(serverName, serverConfig, logger, config.connectTimeoutMs))
  }

  /** server name -> loader tool registration disposer */
  const loaders = new Map<string, () => void>()
  /** server name -> raw tool name -> registration disposer (the live generation) */
  const loaded = new Map<string, Map<string, () => void>>()
  /** server name -> in-flight load, so the startup probe and a loader call cannot double-register */
  const pending = new Map<string, Promise<Map<string, () => void>>>()
  /** server name -> pending idle-disconnect timer (armed only while that server has no loaded tools) */
  const idleTimers = new Map<string, NodeJS.Timeout>()
  /** server name -> how many idle disconnects have fired for it (log counter) */
  const idleDisconnectCount = new Map<string, number>()

  /** Cancel a server's pending idle-disconnect timer, if any. */
  function clearIdleTimer(serverName: string): void {
    const timer = idleTimers.get(serverName)
    if (timer === undefined) return
    clearTimeout(timer)
    idleTimers.delete(serverName)
  }

  /**
   * Reconcile a server's idle timer after its loaded-tool count changed:
   * disarm while tools are loaded; arm once the server is empty and
   * `idleDisconnectMs > 0`, so an unloaded-but-connected server does not keep
   * its MCP child alive forever. Firing soft-disconnects the connection; the
   * next load reconnects lazily (config survives).
   */
  function reconcileIdleTimer(serverName: string): void {
    clearIdleTimer(serverName)
    const idleMs = serverConfigs[serverName]?.idleDisconnectMs ?? 0
    if (idleMs <= 0) return
    if ((loaded.get(serverName)?.size ?? 0) > 0) return
    const connection = connections.get(serverName)
    if (connection === undefined) return
    // Nothing to disconnect when no connection exists yet (never loaded).
    if (!connection.status().connected) return
    const timer = setTimeout(() => {
      idleTimers.delete(serverName)
      // A load may have raced the timer: never disconnect a server that has
      // tools again, and never disconnect mid-load.
      if ((loaded.get(serverName)?.size ?? 0) > 0) return
      if (pending.has(serverName)) {
        reconcileIdleTimer(serverName)
        return
      }
      if (!connection.status().connected) return
      const ordinal = (idleDisconnectCount.get(serverName) ?? 0) + 1
      idleDisconnectCount.set(serverName, ordinal)
      void connection.disconnect().then(
        () => logger.info(`[tool-aggregator] MCP server "${serverName}" disconnected after idle (#${ordinal})`),
        (error) => logger.warn(`[tool-aggregator] idle disconnect of "${serverName}" failed: ${messageOf(error)}`),
      )
    }, idleMs)
    timer.unref?.()
    idleTimers.set(serverName, timer)
  }

  /**
   * server name -> deny mask (public tool names) for that server's *currently
   * loaded* generation. Recomputed from the expanded `hiddenTools` rules
   * whenever a generation registers (load, re-sync), so glob rules are matched
   * against the discovered tool set at load time. Merged from the retired
   * `inkstone-tool-hide` plugin: the mask is a per-agent `restrict()`, which
   * only filters inherited (global) tools — which is why this plugin registers
   * globally. The server's own loader tool is never part of the mask.
   */
  const denyMasks = new Map<string, string[]>()
  /** Servers whose loader-name hit by a hiddenTools glob already warned about. */
  const loaderHitWarned = new Set<string>()
  /** agent -> servers whose deny mask that agent already carries (weak: no retention). */
  const restricted = new WeakMap<object, Set<string>>()

  /**
   * Filter a server's discovered tools through its `disabledTools` rules
   * (registration axis): matched tools are dropped before registration, so
   * they count toward no loaded-tool total and are invisible to every agent.
   * The loader tool is never a discovered MCP tool, so it cannot be disabled.
   */
  function applyToolFilter(connection: ServerConnection, discovered: DiscoveredTool[]): DiscoveredTool[] {
    const rules = serverConfigs[connection.name]?.disabledTools ?? []
    if (rules.length === 0) return discovered
    const dropped = new Set<string>()
    for (const rule of rules) {
      const matcher = ruleToRegExp(rule)
      const publicRule = rule.startsWith('mcp__')
      for (const tool of discovered) {
        if (matcher.test(publicRule ? tool.publicName : tool.rawName)) dropped.add(tool.publicName)
      }
    }
    if (dropped.size === 0) return discovered
    return discovered.filter((tool) => !dropped.has(tool.publicName))
  }

  /**
   * Recompute the deny mask of `serverName` from its expanded `hiddenTools`
   * rules over `available` (the tools about to be / just registered), warning
   * once when a glob rule would also cover the server's own loader tool.
   */
  function refreshDenyMask(serverName: string, available: DiscoveredTool[]): void {
    const config = serverConfigs[serverName]
    if ((config.hiddenTools ?? []).length === 0) {
      denyMasks.delete(serverName)
      return
    }
    const { deny, loaderHit } = expandToolRules(serverName, config, available)
    if (loaderHit && !loaderHitWarned.has(serverName)) {
      loaderHitWarned.add(serverName)
      const loaderName = config.loaderName ?? loaderNameDefault(serverName)
      logger.warn(
        `[tool-aggregator] server "${serverName}": a hiddenTools glob also covers its own loader tool "${loaderName}"; the loader is kept visible`,
      )
    }
    if (deny.length === 0) denyMasks.delete(serverName)
    else denyMasks.set(serverName, deny)
  }

  /** Apply every ready server's deny mask to one agent, once per server. */
  function restrictAgent(agent: unknown): void {
    if (typeof agent !== 'object' || agent === null) return
    let done = restricted.get(agent)
    if (done === undefined) {
      done = new Set<string>()
      restricted.set(agent, done)
    }
    for (const [serverName, names] of denyMasks) {
      if (done.has(serverName)) continue
      if ((loaded.get(serverName)?.size ?? 0) === 0) continue
      const agentTools = (agent as { ctx?: { tools?: { restrict?: (filter: { deny: string[] }) => unknown } } })
        .ctx?.tools
      if (agentTools?.restrict === undefined) continue
      try {
        agentTools.restrict({ deny: names })
        done.add(serverName)
        logger.info(`[tool-aggregator] hid ${names.length} tool(s) of "${serverName}" from one agent`)
      } catch (error) {
        logger.warn(
          `[tool-aggregator] could not hide tools of "${serverName}" from an agent: ${messageOf(error)}`,
        )
      }
    }
  }

  /** Apply the masks to the calling agent and every agent the harness knows about. */
  function restrictAllAgents(caller?: unknown): void {
    restrictAgent(caller)
    const agents = ctx.get('agents') as { list?: () => unknown[] } | undefined
    for (const agent of agents?.list?.() ?? []) restrictAgent(agent)
  }

  /** Deep-copy a parameter schema, truncating every long `description`. */
  function trimParameterDescriptions(node: unknown, cap: number): unknown {
    if (Array.isArray(node)) return node.map((entry) => trimParameterDescriptions(entry, cap))
    if (typeof node !== 'object' || node === null) return node
    const copy: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'description' && typeof value === 'string' && value.length > cap) {
        copy[key] = `${value.slice(0, cap - 1)}…`
      } else if (typeof value === 'object' && value !== null) {
        copy[key] = trimParameterDescriptions(value, cap)
      } else {
        copy[key] = value
      }
    }
    return copy
  }

  const loaderNameOf = (serverName: string): string =>
    serverConfigs[serverName].loaderName ?? loaderNameDefault(serverName)

  /** Map one MCP result to model-facing text, keeping non-text blocks visible. */
  function renderMcpContent(content: unknown, rawName: string): string {
    if (!Array.isArray(content)) {
      if (typeof content === 'string') return content
      return content === undefined ? `(${rawName} returned no output)` : JSON.stringify(content)
    }
    const parts: string[] = []
    for (const block of content) {
      if (typeof block !== 'object' || block === null) {
        parts.push(JSON.stringify(block))
        continue
      }
      const record = block as Record<string, unknown>
      if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
      else if (record.type === 'image') parts.push(`[image ${String(record.mimeType ?? 'unknown')}]`)
      else if (record.type === 'audio') parts.push(`[audio ${String(record.mimeType ?? 'unknown')}]`)
      else parts.push(JSON.stringify(block))
    }
    return parts.join('\n') || `(${rawName} returned no output)`
  }

  /** Build the registry definition for one discovered MCP tool. */
  function definitionFor(connection: ServerConnection, tool: DiscoveredTool): ToolDefinition {
    const serverConfig = serverConfigs[connection.name]
    const overrides = descriptionOverridesFor(serverConfig)
    const presetCap =
      serverConfig.descriptionPreset === undefined
        ? undefined
        : PRESET_PARAMETER_DESCRIPTION_CAP[serverConfig.descriptionPreset]
    const parameterCap = serverConfig.maxParameterDescriptionChars ?? presetCap ?? 0
    return {
      name: tool.publicName,
      description:
        overrides?.[tool.rawName]
        ?? (tool.description || `MCP tool "${tool.rawName}" from server "${connection.name}".`),
      parameters: (parameterCap > 0
        ? trimParameterDescriptions(tool.inputSchema, parameterCap)
        : tool.inputSchema) as unknown as ToolDefinition['parameters'],
      output: {
        schema: {
          type: 'object',
          properties: {
            content: { type: 'array', items: {} },
            structuredContent: {},
          },
          required: ['content'],
        },
        render(_args, value) {
          const record = value as { content?: unknown } | null
          return [{ type: 'text', text: renderMcpContent(record?.content, tool.rawName) }]
        },
      },
      async execute(args, exec) {
        const result = await connection.callTool(tool.rawName, args, exec.signal)
        const text = renderMcpContent(result.content, tool.rawName)
        if (result.isError === true) throw new Error(text)
        return {
          content: result.content ?? [],
          ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
        }
      },
    }
  }

  /** Register one generation, rolling back to zero on the first failure. */
  function registerGeneration(connection: ServerConnection, discovered: DiscoveredTool[]): Map<string, () => void> {
    const next = new Map<string, () => void>()
    try {
      for (const tool of discovered) next.set(tool.rawName, registry.register(definitionFor(connection, tool)))
    } catch (error) {
      for (const dispose of next.values()) {
        try {
          dispose()
        } catch {
          // Rollback is best effort; nothing from this generation survives.
        }
      }
      throw error
    }
    return next
  }

  /** Load one server's tools, deduplicating concurrent attempts. */
  function loadServer(connection: ServerConnection, caller?: unknown): Promise<Map<string, () => void>> {
    const existing = loaded.get(connection.name)
    if (existing !== undefined && existing.size > 0) return Promise.resolve(existing)
    const inflight = pending.get(connection.name)
    if (inflight !== undefined) return inflight
    const attempt = (async () => {
      try {
        const discovered = await connection.listTools()
        const available = applyToolFilter(connection, discovered)
        if (available.length === 0) {
          // No usable tools: either the server exposes none or `disabledTools`
          // suppressed them all. Both end as an empty generation.
          const empty = new Map<string, () => void>()
          loaded.set(connection.name, empty)
          denyMasks.delete(connection.name)
          clearIdleTimer(connection.name)
          if (discovered.length > 0) {
            logger.info(
              `[tool-aggregator] loaded 0 tool(s) from "${connection.name}" (${discovered.length} tool(s) suppressed by disabledTools)`,
            )
          }
          return empty
        }
        const generation = registerGeneration(connection, available)
        loaded.set(connection.name, generation)
        refreshDenyMask(connection.name, available)
        clearIdleTimer(connection.name)
        restrictAllAgents(caller)
        logger.info(`[tool-aggregator] loaded ${generation.size} tool(s) from "${connection.name}"`)
        return generation
      } catch (error) {
        // A failed load may still have left the connection established while no
        // tools are registered — exactly the idle candidate when the option is on.
        reconcileIdleTimer(connection.name)
        throw error
      }
    })().finally(() => {
      pending.delete(connection.name)
    })
    pending.set(connection.name, attempt)
    return attempt
  }

  /** Hide a loaded server's tools again; returns how many registrations were released. */
  function unloadServer(serverName: string): number {
    const generation = loaded.get(serverName)
    if (generation === undefined) return 0
    loaded.delete(serverName)
    denyMasks.delete(serverName)
    for (const dispose of generation.values()) {
      try {
        dispose()
      } catch (error) {
        logger.warn(`[tool-aggregator] disposing a tool of "${serverName}" failed: ${messageOf(error)}`)
      }
    }
    // An unloaded server is exactly the idle-disconnect candidate: arm the
    // timer when `idleDisconnectMs` opts in (default 0 keeps it warm).
    reconcileIdleTimer(serverName)
    return generation.size
  }

  /** Register the model-facing loader tool for one server. */
  function registerLoader(serverName: string): void {
    const connection = connections.get(serverName) as ServerConnection
    const capability = serverConfigs[serverName].description?.trim()
    const head = capability === undefined || capability.length === 0 ? `MCP server "${serverName}".` : capability
    const separator = /[.!?。！？)\]]$/.test(head) ? ' ' : '. '
    const definition: ToolDefinition = {
      name: loaderNameOf(serverName),
      description: `${head}${separator}${loaderHint}`,
      parameters: { type: 'object', properties: {} },
      output: {
        schema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [{ type: 'text', text: (value as { text: string }).text }]
        },
      },
      async execute(_args: unknown, exec: ToolRunContext) {
        const current = loaded.get(connection.name)
        if (current !== undefined && current.size > 0) {
          const removed = unloadServer(connection.name)
          return { text: `ok (${removed} tool(s) hidden)` }
        }
        await loadServer(connection, exec.agent)
        return { text: 'ok' }
      },
    }
    loaders.set(serverName, registry.register(definition))
  }

  function disposeLoader(serverName: string): void {
    const dispose = loaders.get(serverName)
    if (dispose === undefined) return
    loaders.delete(serverName)
    try {
      dispose()
    } catch (error) {
      logger.warn(`[tool-aggregator] disposing the loader of "${serverName}" failed: ${messageOf(error)}`)
    }
  }

  /**
   * Replace the live generation for a server after its tool list changed.
   * `discovered` must already be `disabledTools`-filtered (resync does that
   * before calling); the deny mask is refreshed here against what registered.
   */
  function swapGeneration(connection: ServerConnection, discovered: DiscoveredTool[]): void {
    const previous = loaded.get(connection.name)
    if (previous === undefined || previous.size === 0) return
    for (const dispose of previous.values()) {
      try {
        dispose()
      } catch (error) {
        logger.warn(`[tool-aggregator] disposing a tool of "${connection.name}" failed: ${messageOf(error)}`)
      }
    }
    try {
      loaded.set(connection.name, registerGeneration(connection, discovered))
      refreshDenyMask(connection.name, discovered)
      clearIdleTimer(connection.name)
    } catch (error) {
      loaded.delete(connection.name)
      denyMasks.delete(connection.name)
      logger.error(
        `[tool-aggregator] re-sync of "${connection.name}" could not re-register its tools: ${messageOf(error)}; that server is now unloaded`,
      )
      reconcileIdleTimer(connection.name)
    }
  }

  async function resync(connection: ServerConnection): Promise<void> {
    let discovered: DiscoveredTool[]
    try {
      discovered = await connection.listTools(true)
    } catch (error) {
      logger.warn(`[tool-aggregator] re-sync of "${connection.name}" failed: ${messageOf(error)}`)
      // A re-sync racing an idle disconnect has its retries cancelled, but a
      // failure on a still-connected server leaves it unloaded and warm —
      // re-arm the idle timer either way.
      reconcileIdleTimer(connection.name)
      return
    }
    const available = applyToolFilter(connection, discovered)
    swapGeneration(connection, available)
    logger.info(`[tool-aggregator] re-synced "${connection.name}" (${available.length} tools)`)
    // Normally a disarm/no-op (a re-sync only swaps an already-loaded
    // generation). When it ends with no loaded tools — e.g. it raced an idle
    // disconnect that a retry had revived — re-arming keeps the timer correct.
    reconcileIdleTimer(connection.name)
  }

  /**
   * Classify every `auto` server once: a small server is registered eagerly and
   * loses its loader; a multi-tool server keeps its loader.
   */
  async function probeServers(): Promise<void> {
    // An explicit `lazy` server needs no classification, so it is never spawned
    // at startup; only `auto` and `eager` servers are.
    const entries = [...connections.values()].filter(
      (connection) => (serverConfigs[connection.name].mode ?? 'auto') !== 'lazy',
    )
    const settled = await Promise.allSettled(
      entries.map(async (connection) => ({ connection, discovered: await connection.listTools() })),
    )
    for (const [index, result] of settled.entries()) {
      const connection = entries[index]
      if (result.status === 'rejected') {
        logger.warn(
          `[tool-aggregator] startup probe of "${connection.name}" failed: ${messageOf(result.reason)}; keeping its loader tool`,
        )
        continue
      }
      const { discovered } = result.value
      const available = applyToolFilter(connection, discovered)
      if (available.length === 0) {
        disposeLoader(connection.name)
        if (discovered.length > 0) {
          logger.info(
            `[tool-aggregator] "${connection.name}" exposes no tools (${discovered.length} tool(s) suppressed by disabledTools)`,
          )
        } else {
          logger.info(`[tool-aggregator] "${connection.name}" exposes no tools`)
        }
        continue
      }
      const mode = serverConfigs[connection.name].mode ?? 'auto'
      const eager = mode === 'eager' || (mode === 'auto' && available.length <= singleToolThreshold)
      if (!eager) {
        logger.info(
          `[tool-aggregator] "${connection.name}": ${available.length} tools hidden behind loader "${loaderNameOf(connection.name)}"`,
        )
        // The probe connected a server that stays behind its loader: when the
        // idle option is on, arm it so a never-loaded server is not warm forever.
        reconcileIdleTimer(connection.name)
        continue
      }
      try {
        const generation = await loadServer(connection)
        disposeLoader(connection.name)
        logger.info(`[tool-aggregator] "${connection.name}": ${generation.size} tool(s) registered eagerly`)
      } catch (error) {
        logger.error(
          `[tool-aggregator] eager registration of "${connection.name}" failed: ${messageOf(error)}; keeping its loader tool`,
        )
      }
    }
  }

  for (const connection of connections.values()) {
    connection.onToolsChanged(() => {
      void resync(connection)
    })
  }

  for (const serverName of Object.keys(serverConfigs)) registerLoader(serverName)

  // An agent created after a masked server was loaded still needs its deny mask.
  ctx.on?.('agent/created', (payload: { agent?: unknown } | undefined) => restrictAgent(payload?.agent))

  ctx.effect(() => () => {
    for (const dispose of loaders.values()) {
      try {
        dispose()
      } catch {
        // Plugin teardown is best effort.
      }
    }
    loaders.clear()
    for (const generation of loaded.values()) {
      for (const dispose of generation.values()) {
        try {
          dispose()
        } catch {
          // Plugin teardown is best effort.
        }
      }
    }
    loaded.clear()
    pending.clear()
    for (const timer of idleTimers.values()) clearTimeout(timer)
    idleTimers.clear()
    idleDisconnectCount.clear()
    for (const connection of connections.values()) void connection.close()
    connections.clear()
  }, 'tool-aggregator cleanup')

  if (probeAtStartup && connections.size > 0) {
    void probeServers().catch((error) => logger.error(`[tool-aggregator] startup probe failed: ${messageOf(error)}`))
  }

  logger.info(
    `[tool-aggregator] ${loaders.size} loader tool(s) registered: ${[...loaders.keys()].map(loaderNameOf).join(', ') || '(none)'}`,
  )
}

export default { name, inject, apply }
