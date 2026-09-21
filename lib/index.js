import { ServerConnection, messageOf, validateServerConfig } from './connection.js';
import { PRESET_PARAMETER_DESCRIPTION_CAP, descriptionOverridesFor } from './presets.js';
/** Appended to every loader tool description unless overridden by config. */
const DEFAULT_LOADER_HINT = "Call to load this MCP server's tools into this session; call again to hide them.";
/** Loader metadata: the plugin owns no service, but it must not apply before the registry. */
export const name = 'tool-aggregator';
/** Cordis dependency: the tool registry must exist before this plugin applies. */
export const inject = ['tools'];
/**
 * Server names already claimed per composition root.
 *
 * Registration is deployment-wide (global), so two instances of this plugin —
 * or this plugin next to the official `dsh-mcp-client` — cannot both own the
 * same server name: the public tool names would collide. Claiming the names at
 * mount time turns that into a named error instead of a silent registration
 * rollback later. Keyed by `ctx.root` rather than by scope, because the
 * collision is global by construction.
 */
const claimedServerNames = new WeakMap();
/** Whether a rule string contains glob metacharacters. */
function isGlobRule(rule) {
    return rule.includes('*') || rule.includes('?');
}
/** Default loader tool name for a server that does not set `loaderName`. */
const loaderNameDefault = (serverName) => `mcp_${serverName}`;
/** Compile a tool rule to an anchored matcher: `*` any run, `?` one char, the rest literal. */
function ruleToRegExp(rule) {
    let source = '';
    for (const char of rule) {
        if (char === '*')
            source += '.*';
        else if (char === '?')
            source += '.';
        else
            source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${source}$`);
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
function expandToolRules(serverName, config, discovered) {
    const loaderName = config.loaderName ?? loaderNameDefault(serverName);
    const deny = new Set();
    let loaderHit = false;
    for (const rule of config.hiddenTools ?? []) {
        const matcher = ruleToRegExp(rule);
        const publicRule = rule.startsWith('mcp__');
        for (const tool of discovered) {
            if (matcher.test(publicRule ? tool.publicName : tool.rawName))
                deny.add(tool.publicName);
        }
        // The loader tool is registered globally and visible per agent, so a
        // pattern that covers its name must never reach an agent's deny mask.
        if (matcher.test(loaderName))
            loaderHit = true;
    }
    deny.delete(loaderName);
    return { deny: [...deny], loaderHit };
}
export function apply(ctx, config = {}) {
    const serverConfigs = config.servers ?? {};
    const loaderHint = config.loaderHint ?? DEFAULT_LOADER_HINT;
    const singleToolThreshold = config.singleToolThreshold ?? 1;
    const probeAtStartup = config.probeAtStartup ?? true;
    if (!Number.isInteger(singleToolThreshold) || singleToolThreshold < 0) {
        throw new Error('tool-aggregator: "singleToolThreshold" must be a non-negative integer');
    }
    const logger = {
        info: (message) => ctx.logger?.info?.(message),
        warn: (message) => ctx.logger?.warn?.(message),
        error: (message) => ctx.logger?.error?.(message),
    };
    for (const [serverName, serverConfig] of Object.entries(serverConfigs)) {
        const problems = validateServerConfig(serverName, serverConfig);
        // Lockout protection, statically decidable: a hiddenTools/disabledTools
        // rule that textually equals this server's own loader tool name would hide
        // or disable the toggle every agent uses to reach the server. Fail fast by
        // naming the loader instead of waiting for a load.
        const loaderName = serverConfig.loaderName ?? loaderNameDefault(serverName);
        for (const field of ['hiddenTools', 'disabledTools']) {
            for (const rule of serverConfig[field] ?? []) {
                if (typeof rule !== 'string') {
                    problems.push(`"${field}" entry must be a string, got ${typeof rule}`);
                    continue;
                }
                if (!isGlobRule(rule) && rule === loaderName) {
                    problems.push(`"${field}" rule "${rule}" equals this server's loader name "${loaderName}"; rename the loader or drop the rule`);
                }
            }
        }
        if (problems.length > 0)
            throw new Error(`tool-aggregator: server "${serverName}": ${problems.join('; ')}`);
        // Fail fast on an unknown description preset instead of at first load.
        descriptionOverridesFor(serverConfig);
    }
    // Claim every server name in this composition root: a second instance with
    // the same name would register the same public tool names globally.
    const root = ctx.root;
    let claimed = claimedServerNames.get(root);
    if (claimed === undefined) {
        claimed = new Set();
        claimedServerNames.set(root, claimed);
    }
    const owner = Object.keys(serverConfigs).find((serverName) => claimed.has(serverName));
    if (owner !== undefined) {
        throw new Error(`tool-aggregator: server name "${owner}" is already in use by another tool-aggregator instance in this composition; `
            + 'pick a unique server name (the official dsh-mcp-client must not serve the same name either — the public tool names would collide)');
    }
    for (const serverName of Object.keys(serverConfigs))
        claimed.add(serverName);
    const found = ctx.get('tools');
    if (found === undefined) {
        throw new Error('tool-aggregator requires @deepseek-ai/dsh-tools (ctx.tools) in the composition');
    }
    /** Non-optional binding so closures see the narrowed type. */
    const registry = found;
    const connections = new Map();
    for (const [serverName, serverConfig] of Object.entries(serverConfigs)) {
        connections.set(serverName, new ServerConnection(serverName, serverConfig, logger, { connectTimeoutMs: config.connectTimeoutMs }));
    }
    /** server name -> loader tool registration disposer */
    const loaders = new Map();
    /** server name -> raw tool name -> registration disposer (the live generation) */
    const loaded = new Map();
    /** server name -> in-flight load, so the startup probe and a loader call cannot double-register */
    const pending = new Map();
    /** server name -> pending idle-disconnect timer (armed only while that server has no loaded tools) */
    const idleTimers = new Map();
    /** server name -> how many idle disconnects have fired for it (log counter) */
    const idleDisconnectCount = new Map();
    /** server name -> resource-provider deregistration for the loaded server */
    const resourceDisposers = new Map();
    /** The host's resource runtime, once (and if) the composition provides one. */
    let resourceRuntime;
    /** Whether the "no resource runtime" notice was already logged. */
    let resourceUnavailableLogged = false;
    /**
     * Make a loaded server's resources reachable through the host's resource
     * runtime, when one is composed.
     *
     * Registration is lazy on purpose: a server that was never expanded should not
     * publish a resource surface, and a composition without the runtime keeps
     * working with a single informational line instead of an error.
     */
    function ensureResourceProvider(serverName) {
        if (resourceRuntime === undefined) {
            if (!resourceUnavailableLogged) {
                resourceUnavailableLogged = true;
                logger.info('[tool-aggregator] no mcpResources service in this composition; MCP resources stay unbridged');
            }
            return;
        }
        if (resourceDisposers.has(serverName))
            return;
        const connection = connections.get(serverName);
        if (connection === undefined)
            return;
        try {
            resourceDisposers.set(serverName, resourceRuntime.register(serverName, {
                request: (request, exec) => connection.requestResources(request, exec?.signal ?? new AbortController().signal),
            }));
        }
        catch (error) {
            logger.warn(`[tool-aggregator] registering resources of "${serverName}" failed: ${messageOf(error)}`);
        }
    }
    /** Withdraw a server's resource provider (unload or teardown). */
    function disposeResourceProvider(serverName) {
        const dispose = resourceDisposers.get(serverName);
        if (dispose === undefined)
            return;
        resourceDisposers.delete(serverName);
        try {
            dispose();
        }
        catch (error) {
            logger.warn(`[tool-aggregator] disposing resources of "${serverName}" failed: ${messageOf(error)}`);
        }
    }
    // The resource runtime is an optional peer: `inject` waits for it without
    // failing this plugin, and servers already loaded when it appears (or that load
    // later) publish their provider through the same path.
    ctx.inject(['mcpResources'], (inner) => {
        resourceRuntime = inner.mcpResources;
        for (const serverName of loaded.keys())
            ensureResourceProvider(serverName);
    });
    /** Cancel a server's pending idle-disconnect timer, if any. */
    function clearIdleTimer(serverName) {
        const timer = idleTimers.get(serverName);
        if (timer === undefined)
            return;
        clearTimeout(timer);
        idleTimers.delete(serverName);
    }
    /**
     * Reconcile a server's idle timer after its loaded-tool count changed:
     * disarm while tools are loaded; arm once the server is empty and
     * `idleDisconnectMs > 0`, so an unloaded-but-connected server does not keep
     * its MCP child alive forever. Firing soft-disconnects the connection; the
     * next load reconnects lazily (config survives).
     */
    function reconcileIdleTimer(serverName) {
        clearIdleTimer(serverName);
        const idleMs = serverConfigs[serverName]?.idleDisconnectMs ?? 0;
        if (idleMs <= 0)
            return;
        if ((loaded.get(serverName)?.disposers.size ?? 0) > 0)
            return;
        const connection = connections.get(serverName);
        if (connection === undefined)
            return;
        // Nothing to disconnect when no connection exists yet (never loaded).
        if (!connection.status().connected)
            return;
        const timer = setTimeout(() => {
            idleTimers.delete(serverName);
            // A load may have raced the timer: never disconnect a server that has
            // tools again, and never disconnect mid-load.
            if ((loaded.get(serverName)?.disposers.size ?? 0) > 0)
                return;
            if (pending.has(serverName)) {
                reconcileIdleTimer(serverName);
                return;
            }
            if (!connection.status().connected)
                return;
            const ordinal = (idleDisconnectCount.get(serverName) ?? 0) + 1;
            idleDisconnectCount.set(serverName, ordinal);
            void connection.disconnect().then(() => logger.info(`[tool-aggregator] MCP server "${serverName}" disconnected after idle (#${ordinal})`), (error) => logger.warn(`[tool-aggregator] idle disconnect of "${serverName}" failed: ${messageOf(error)}`));
        }, idleMs);
        timer.unref?.();
        idleTimers.set(serverName, timer);
    }
    /**
     * server name -> deny mask (public tool names) for that server's *currently
     * loaded* generation, derived from the expanded `hiddenTools` rules whenever a
     * generation registers (load, re-sync), so glob rules are matched against the
     * discovered tool set at load time. Merged from the retired
     * `inkstone-tool-hide` plugin: the mask is a per-agent `restrict()`, which
     * only filters inherited (global) tools — which is why this plugin registers
     * globally. The server's own loader tool is never part of the mask.
     */
    const hideMasks = new Map();
    /** Servers whose loader-name hit by a hiddenTools glob already warned about. */
    const loaderHitWarned = new Set();
    /**
     * server name -> session ids that toggled that server ON (slice 04).
     *
     * The loader is a per-session switch: a session that never called it must not
     * inherit another session's disclosure, and a session created after a load must
     * not start out expanded. A server with an empty holder set was loaded through
     * the agentless path, which has no session to scope the disclosure to, and
     * keeps the deployment-wide v0.5.0 behavior.
     */
    const holders = new Map();
    /**
     * server name -> agent -> the deny mask that agent currently carries.
     *
     * Strong keys, not a WeakMap: a mask must be lifted and recomputed when the
     * agent's holder status or the server's tool list changes, which needs
     * iteration. Entries are dropped on `agent/disposed` and when a mask empties;
     * the registration itself is owned by the agent's scope, so a disposed agent
     * releases it independently of this bookkeeping.
     */
    const appliedMasks = new Map();
    /**
     * Live agents by session id, learned from `agent/created` and refreshed from
     * the `agents` service when one is composed. Ancestor headers are read from
     * here so a subagent's lineage resolves without holding the whole registry.
     */
    const liveAgents = new Map();
    /**
     * Filter a server's discovered tools through its `disabledTools` rules
     * (registration axis): matched tools are dropped before registration, so
     * they count toward no loaded-tool total and are invisible to every agent.
     * The loader tool is never a discovered MCP tool, so it cannot be disabled.
     */
    function applyToolFilter(connection, discovered) {
        const rules = serverConfigs[connection.name]?.disabledTools ?? [];
        if (rules.length === 0)
            return discovered;
        const dropped = new Set();
        for (const rule of rules) {
            const matcher = ruleToRegExp(rule);
            const publicRule = rule.startsWith('mcp__');
            for (const tool of discovered) {
                if (matcher.test(publicRule ? tool.publicName : tool.rawName))
                    dropped.add(tool.publicName);
            }
        }
        if (dropped.size === 0)
            return discovered;
        return discovered.filter((tool) => !dropped.has(tool.publicName));
    }
    /**
     * Recompute the deny mask of `serverName` from its expanded `hiddenTools`
     * rules over `available` (the tools about to be / just registered), warning
     * once when a glob rule would also cover the server's own loader tool.
     */
    function refreshDenyMask(serverName, available) {
        const config = serverConfigs[serverName];
        if ((config.hiddenTools ?? []).length === 0) {
            hideMasks.delete(serverName);
            return;
        }
        const { deny, loaderHit } = expandToolRules(serverName, config, available);
        if (loaderHit && !loaderHitWarned.has(serverName)) {
            loaderHitWarned.add(serverName);
            const loaderName = config.loaderName ?? loaderNameDefault(serverName);
            logger.warn(`[tool-aggregator] server "${serverName}": a hiddenTools glob also covers its own loader tool "${loaderName}"; the loader is kept visible`);
        }
        if (deny.length === 0)
            hideMasks.delete(serverName);
        else
            hideMasks.set(serverName, deny);
    }
    /** The session id behind an agent-shaped value, when it carries one. */
    function sessionIdOf(agent) {
        const shaped = agent;
        const fromHeader = shaped?.session?.header?.id;
        if (typeof fromHeader === 'string')
            return fromHeader;
        return typeof shaped?.id === 'string' ? shaped.id : undefined;
    }
    /** The session header behind an agent-shaped value, when it carries one. */
    function headerOf(agent) {
        return agent
            ?.session?.header;
    }
    /**
     * The session ids whose holder status governs `agent`, nearest first.
     *
     * A subagent is created through its parent's context and must inherit the
     * parent's disclosure, so the walk follows `parentSession` while — and only
     * while — each link is a `subagent` child. A fork carries `parentSession` as
     * seed lineage and no `origin`, which deliberately stops the walk: a fork is a
     * new session and must start unexpanded. Nodes whose agent is not live stop
     * the walk at their own id, which still lets a directly-named holder answer.
     */
    function ancestryIds(agent) {
        const ids = [];
        const seen = new Set();
        let header = headerOf(agent);
        if (header === undefined) {
            // An agent carrying only an id cannot be walked upwards, but it can still
            // be a holder in its own right.
            const direct = sessionIdOf(agent);
            return direct === undefined ? ids : [direct];
        }
        while (typeof header?.id === 'string' && !seen.has(header.id)) {
            seen.add(header.id);
            ids.push(header.id);
            if (header.origin !== 'subagent' || header.parentSession === undefined)
                break;
            header = headerOf(liveAgents.get(header.parentSession)) ?? { id: header.parentSession };
        }
        return ids;
    }
    /** Whether `agent` is a holder of `serverName`, or works under one. */
    function isHolder(serverName, agent) {
        const set = holders.get(serverName);
        if (set === undefined || set.size === 0)
            return false;
        for (const id of ancestryIds(agent))
            if (set.has(id))
                return true;
        return false;
    }
    /**
     * The deny mask one agent must carry for one loaded server.
     *
     * Empty when the server is not loaded, and empty for every agent when the
     * generation has no holder (the agentless path, which keeps the deployment-wide
     * v0.5.0 behavior) or when the server has no loader tool left to reveal it
     * again — an eager server masked for everyone would be unreachable.
     */
    function denyFor(serverName, agent) {
        const generation = loaded.get(serverName);
        if (generation === undefined || generation.names.length === 0)
            return [];
        const hidden = hideMasks.get(serverName) ?? [];
        if (!loaders.has(serverName))
            return hidden;
        const set = holders.get(serverName);
        if (set === undefined || set.size === 0)
            return hidden;
        if (isHolder(serverName, agent))
            return hidden;
        const deny = new Set(hidden);
        for (const name of generation.names)
            deny.add(name);
        return [...deny];
    }
    /** Whether two deny lists carry the same names. */
    function sameDeny(left, right) {
        if (left === undefined || left.length !== right.length)
            return false;
        const have = new Set(left);
        for (const name of right)
            if (!have.has(name))
                return false;
        return true;
    }
    /** Reconcile one agent's deny masks with the current holders and generations. */
    function syncAgent(agent) {
        if (typeof agent !== 'object' || agent === null)
            return;
        const agentTools = agent
            .ctx?.tools;
        if (agentTools?.restrict === undefined)
            return;
        for (const serverName of new Set([...loaded.keys(), ...appliedMasks.keys()])) {
            const desired = denyFor(serverName, agent);
            let map = appliedMasks.get(serverName);
            const current = map?.get(agent);
            if (sameDeny(current?.deny, desired))
                continue;
            if (current !== undefined && map !== undefined) {
                map.delete(agent);
                try {
                    current.dispose();
                }
                catch {
                    // Lifting a mask is best effort; the agent's scope owns it too.
                }
            }
            if (desired.length === 0)
                continue;
            try {
                const dispose = agentTools.restrict({ deny: desired });
                map ??= new Map();
                appliedMasks.set(serverName, map);
                map.set(agent, { deny: desired, dispose });
            }
            catch (error) {
                logger.warn(`[tool-aggregator] could not mask tools of "${serverName}" for an agent: ${messageOf(error)}`);
            }
        }
    }
    /** Reconcile every agent the harness knows about, plus the caller. */
    function syncAgents(caller) {
        rememberAgents();
        syncAgent(caller);
        for (const agent of liveAgents.values())
            syncAgent(agent);
    }
    /** Refresh the live-agent map from the `agents` service when it is composed. */
    function rememberAgents() {
        const agents = ctx.get('agents');
        for (const agent of agents?.list?.() ?? []) {
            const id = sessionIdOf(agent);
            if (id !== undefined)
                liveAgents.set(id, agent);
        }
    }
    /** Forget one agent entirely: its ids, its holder entries and its masks. */
    function forgetAgent(agent) {
        const id = sessionIdOf(agent);
        if (id !== undefined)
            liveAgents.delete(id);
        for (const map of appliedMasks.values()) {
            const entry = map.get(agent);
            if (entry === undefined)
                continue;
            map.delete(agent);
            try {
                entry.dispose();
            }
            catch {
                // The agent's scope teardown owns the registration as well.
            }
        }
    }
    /** Deep-copy a parameter schema, truncating every long `description`. */
    function trimParameterDescriptions(node, cap) {
        if (Array.isArray(node))
            return node.map((entry) => trimParameterDescriptions(entry, cap));
        if (typeof node !== 'object' || node === null)
            return node;
        const copy = {};
        for (const [key, value] of Object.entries(node)) {
            if (key === 'description' && typeof value === 'string' && value.length > cap) {
                copy[key] = `${value.slice(0, cap - 1)}…`;
            }
            else if (typeof value === 'object' && value !== null) {
                copy[key] = trimParameterDescriptions(value, cap);
            }
            else {
                copy[key] = value;
            }
        }
        return copy;
    }
    const loaderNameOf = (serverName) => serverConfigs[serverName].loaderName ?? loaderNameDefault(serverName);
    /** Map one MCP result to model-facing text, keeping non-text blocks visible. */
    function renderMcpContent(content, rawName) {
        if (!Array.isArray(content)) {
            if (typeof content === 'string')
                return content;
            return content === undefined ? `(${rawName} returned no output)` : JSON.stringify(content);
        }
        const parts = [];
        for (const block of content) {
            if (typeof block !== 'object' || block === null) {
                parts.push(JSON.stringify(block));
                continue;
            }
            const record = block;
            if (record.type === 'text' && typeof record.text === 'string')
                parts.push(record.text);
            else if (record.type === 'image')
                parts.push(`[image ${String(record.mimeType ?? 'unknown')}]`);
            else if (record.type === 'audio')
                parts.push(`[audio ${String(record.mimeType ?? 'unknown')}]`);
            else
                parts.push(JSON.stringify(block));
        }
        return parts.join('\n') || `(${rawName} returned no output)`;
    }
    /** Build the registry definition for one discovered MCP tool. */
    function definitionFor(connection, tool) {
        const serverConfig = serverConfigs[connection.name];
        const overrides = descriptionOverridesFor(serverConfig);
        const presetCap = serverConfig.descriptionPreset === undefined
            ? undefined
            : PRESET_PARAMETER_DESCRIPTION_CAP[serverConfig.descriptionPreset];
        const parameterCap = serverConfig.maxParameterDescriptionChars ?? presetCap ?? 0;
        return {
            name: tool.publicName,
            description: overrides?.[tool.rawName]
                ?? (tool.description || `MCP tool "${tool.rawName}" from server "${connection.name}".`),
            parameters: (parameterCap > 0
                ? trimParameterDescriptions(tool.inputSchema, parameterCap)
                : tool.inputSchema),
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
                    const record = value;
                    return [{ type: 'text', text: renderMcpContent(record?.content, tool.rawName) }];
                },
            },
            async execute(args, exec) {
                const result = await connection.callTool(tool.rawName, args, exec.signal);
                const text = renderMcpContent(result.content, tool.rawName);
                if (result.isError === true)
                    throw new Error(text);
                return {
                    content: result.content ?? [],
                    ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
                };
            },
        };
    }
    /** Register one generation, rolling back to zero on the first failure. */
    function registerGeneration(connection, discovered) {
        const disposers = new Map();
        const names = [];
        try {
            for (const tool of discovered) {
                disposers.set(tool.rawName, registry.register(definitionFor(connection, tool)));
                names.push(tool.publicName);
            }
        }
        catch (error) {
            for (const dispose of disposers.values()) {
                try {
                    dispose();
                }
                catch {
                    // Rollback is best effort; nothing from this generation survives.
                }
            }
            throw error;
        }
        return { disposers, names };
    }
    /**
     * Monotonic per-server discovery generations (slice 03).
     *
     * Discovery results are fetched over the network by several independent
     * dispatches (a loader load, each `list_changed` re-sync), and completion
     * order does not follow dispatch order — an older snapshot can finish last
     * and would overwrite a newer one. Every dispatch takes a version from
     * {@link beginDiscovery}; a landing applies only while no newer discovery has
     * already landed ({@link mayApplyDiscovery}), and a successful landing raises
     * the watermark ({@link commitDiscovery}). The maps are written in exactly
     * those two helpers — the two review points of slice 03.
     *
     * Landing is gated on the *watermark*, not on "still the latest dispatch":
     * a re-sync that fires while a first load is in flight lands nothing (see
     * {@link swapGeneration}: an unloaded server is never re-synced into
     * existence), so gating the load on "latest dispatch" would wrongly discard
     * its landing and leave the server never-loaded.
     */
    /** server name -> version of the newest discovery dispatch (+1 per dispatch). */
    const discoveryVersions = new Map();
    /** server name -> version of the newest discovery that actually landed. */
    const landedVersions = new Map();
    /** Advance point 1 of 2 (slice 03): a new discovery dispatch takes the next version. */
    function beginDiscovery(serverName) {
        const next = (discoveryVersions.get(serverName) ?? 0) + 1;
        discoveryVersions.set(serverName, next);
        return next;
    }
    /** Advance point 2 of 2 (slice 03): a discovery may land while nothing newer landed. */
    function mayApplyDiscovery(serverName, version) {
        return version >= (landedVersions.get(serverName) ?? 0);
    }
    /** Record a successful landing; the watermark only ever rises. */
    function commitDiscovery(serverName, version) {
        landedVersions.set(serverName, version);
    }
    /** Load one server's tools, deduplicating concurrent attempts. */
    function loadServer(connection, caller) {
        const existing = loaded.get(connection.name);
        if (existing !== undefined && existing.disposers.size > 0)
            return Promise.resolve(existing);
        const inflight = pending.get(connection.name);
        if (inflight !== undefined)
            return inflight;
        const attempt = (async () => {
            // A load is a new discovery dispatch: it takes the next generation
            // version (advance point 1 of 2).
            const version = beginDiscovery(connection.name);
            try {
                const discovered = await connection.listTools();
                const available = applyToolFilter(connection, discovered);
                // Landing validation (advance point 2 of 2): never land a snapshot once
                // a newer discovery already landed. Defensive here — a first load is
                // the only landing producer from an empty state (a re-sync never swaps
                // an unloaded server), so this can only trip if that invariant changes.
                if (!mayApplyDiscovery(connection.name, version)) {
                    logger.info(`[tool-aggregator] discarded a stale discovery for "${connection.name}" (a newer one already applied)`);
                    return { disposers: new Map(), names: [] };
                }
                if (available.length === 0) {
                    // No usable tools: either the server exposes none or `disabledTools`
                    // suppressed them all. Both end as an empty generation.
                    const empty = { disposers: new Map(), names: [] };
                    commitDiscovery(connection.name, version);
                    loaded.set(connection.name, empty);
                    hideMasks.delete(connection.name);
                    clearIdleTimer(connection.name);
                    if (discovered.length > 0) {
                        logger.info(`[tool-aggregator] loaded 0 tool(s) from "${connection.name}" (${discovered.length} tool(s) suppressed by disabledTools)`);
                    }
                    return empty;
                }
                const generation = registerGeneration(connection, available);
                commitDiscovery(connection.name, version);
                loaded.set(connection.name, generation);
                refreshDenyMask(connection.name, available);
                clearIdleTimer(connection.name);
                syncAgents(caller);
                logger.info(`[tool-aggregator] loaded ${generation.disposers.size} tool(s) from "${connection.name}"`);
                // A loaded server becomes reachable for resource reads too; an empty
                // generation (no tools) registers no provider, matching "nothing loaded".
                ensureResourceProvider(connection.name);
                return generation;
            }
            catch (error) {
                // A failed load may still have left the connection established while no
                // tools are registered — exactly the idle candidate when the option is on.
                reconcileIdleTimer(connection.name);
                throw error;
            }
        })().finally(() => {
            pending.delete(connection.name);
        });
        pending.set(connection.name, attempt);
        return attempt;
    }
    /**
     * Hide a loaded server's tools again; returns how many registrations were released.
     *
     * Releasing the generation also empties the holder set and reconciles every
     * mask: once nothing is registered, `denyFor` returns the hiddenTools mask
     * alone, so the per-session mask is lifted everywhere in the same pass.
     */
    function unloadServer(serverName) {
        const generation = loaded.get(serverName);
        if (generation === undefined)
            return 0;
        loaded.delete(serverName);
        hideMasks.delete(serverName);
        holders.delete(serverName);
        disposeResourceProvider(serverName);
        for (const dispose of generation.disposers.values()) {
            try {
                dispose();
            }
            catch (error) {
                logger.warn(`[tool-aggregator] disposing a tool of "${serverName}" failed: ${messageOf(error)}`);
            }
        }
        syncAgents();
        // An unloaded server is exactly the idle-disconnect candidate: arm the
        // timer when `idleDisconnectMs` opts in (default 0 keeps it warm).
        reconcileIdleTimer(serverName);
        return generation.disposers.size;
    }
    /**
     * What the loader answers after a successful load: `ok`, plus the server's own
     * MCP instructions when it sent any.
     *
     * The instructions belong in the result rather than the loader description: a
     * description is assembled into every request for as long as the loader
     * exists, while a result is read once, at the moment the session actually
     * expands that server — which is also when they first apply. The block is
     * bounded by `maxInstructionBytes` at connect time, so it cannot grow without
     * the operator seeing a named failure.
     */
    function loadResultText(connection) {
        const instructions = connection.instructions();
        if (instructions === undefined || instructions.length === 0)
            return 'ok';
        return `ok\n\n### MCP server: ${connection.name}\n\n${instructions}`;
    }
    /** Register the model-facing loader tool for one server. */
    function registerLoader(serverName) {
        const connection = connections.get(serverName);
        const capability = serverConfigs[serverName].description?.trim();
        const head = capability === undefined || capability.length === 0 ? `MCP server "${serverName}".` : capability;
        const separator = /[.!?。！？)\]]$/.test(head) ? ' ' : '. ';
        const definition = {
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
                    return [{ type: 'text', text: value.text }];
                },
            },
            async execute(_args, exec) {
                const sessionId = sessionIdOf(exec.agent);
                const set = holders.get(connection.name);
                const current = loaded.get(connection.name);
                // A session that already holds this server toggles it off for itself.
                // The generation is only released once the last holder drops it, so one
                // session hiding its own tools never withdraws another's.
                if (sessionId !== undefined && set?.has(sessionId) === true) {
                    set.delete(sessionId);
                    const hidden = current?.names.length ?? 0;
                    if (set.size === 0) {
                        const removed = unloadServer(connection.name);
                        return { text: `ok (${removed} tool(s) hidden)` };
                    }
                    syncAgents();
                    return { text: `ok (${hidden} tool(s) hidden)` };
                }
                // An agentless call has no session to scope the disclosure to: keep the
                // v0.5.0 deployment-wide toggle, which leaves the holder set empty.
                if (sessionId === undefined) {
                    if (current !== undefined && current.disposers.size > 0) {
                        const removed = unloadServer(connection.name);
                        return { text: `ok (${removed} tool(s) hidden)` };
                    }
                    await loadServer(connection, exec.agent);
                    return { text: loadResultText(connection) };
                }
                let owned = holders.get(connection.name);
                if (owned === undefined) {
                    owned = new Set();
                    holders.set(connection.name, owned);
                }
                owned.add(sessionId);
                try {
                    await loadServer(connection, exec.agent);
                }
                catch (error) {
                    // A failed load must not leave this session holding a server that
                    // registered nothing: the next call would then read as "hide".
                    owned.delete(sessionId);
                    if (owned.size === 0)
                        holders.delete(connection.name);
                    throw error;
                }
                syncAgents(exec.agent);
                return { text: loadResultText(connection) };
            },
        };
        loaders.set(serverName, registry.register(definition));
    }
    function disposeLoader(serverName) {
        const dispose = loaders.get(serverName);
        if (dispose === undefined)
            return;
        loaders.delete(serverName);
        try {
            dispose();
        }
        catch (error) {
            logger.warn(`[tool-aggregator] disposing the loader of "${serverName}" failed: ${messageOf(error)}`);
        }
        // A server with no loader has no way back: masking it would hide tools no
        // session could ever reveal again, so dropping the loader also drops the
        // per-session mask the eager registration made unnecessary.
        syncAgents();
    }
    /**
     * Replace the live generation for a server after its tool list changed.
     * `discovered` must already be `disabledTools`-filtered (resync does that
     * before calling); the deny mask is refreshed here against what registered.
     * Order is unchanged: dispose the previous generation first, then register
     * the next (a duplicate-name register throws — see slice 03 step 0 — so
     * register-new-then-dispose-old is impossible).
     *
     * Returns whether a generation was actually replaced: `false` when the
     * server had nothing loaded (a re-sync never loads an unloaded server into
     * existence) or when re-registration failed and the server was unloaded.
     */
    function swapGeneration(connection, discovered) {
        const previous = loaded.get(connection.name);
        if (previous === undefined || previous.disposers.size === 0)
            return false;
        for (const dispose of previous.disposers.values()) {
            try {
                dispose();
            }
            catch (error) {
                logger.warn(`[tool-aggregator] disposing a tool of "${connection.name}" failed: ${messageOf(error)}`);
            }
        }
        try {
            loaded.set(connection.name, registerGeneration(connection, discovered));
            refreshDenyMask(connection.name, discovered);
            clearIdleTimer(connection.name);
            return true;
        }
        catch (error) {
            loaded.delete(connection.name);
            hideMasks.delete(connection.name);
            holders.delete(connection.name);
            logger.error(`[tool-aggregator] re-sync of "${connection.name}" could not re-register its tools: ${messageOf(error)}; that server is now unloaded`);
            reconcileIdleTimer(connection.name);
            return false;
        }
    }
    async function resync(connection) {
        // A re-sync is a new discovery dispatch: every `list_changed` bumps the
        // generation (advance point 1 of 2), so of two concurrent re-syncs the
        // older snapshot can never land after — and overwrite — the newer one.
        const version = beginDiscovery(connection.name);
        let discovered;
        try {
            discovered = await connection.listTools(true);
        }
        catch (error) {
            logger.warn(`[tool-aggregator] re-sync of "${connection.name}" failed: ${messageOf(error)}`);
            // A re-sync racing an idle disconnect has its retries cancelled, but a
            // failure on a still-connected server leaves it unloaded and warm —
            // re-arm the idle timer either way.
            reconcileIdleTimer(connection.name);
            return;
        }
        const available = applyToolFilter(connection, discovered);
        // Landing validation (advance point 2 of 2): a stale snapshot (fetched
        // before a newer re-sync landed) is dropped instead of swapping the newer
        // generation back to older content.
        if (!mayApplyDiscovery(connection.name, version)) {
            logger.info(`[tool-aggregator] re-sync of "${connection.name}" discarded a stale discovery (a newer one already applied)`);
            return;
        }
        if (swapGeneration(connection, available)) {
            commitDiscovery(connection.name, version);
            // A re-sync can introduce names that no per-session mask has denied yet,
            // so the masks are recomputed after every landing rather than only for
            // agents created later.
            syncAgents();
            logger.info(`[tool-aggregator] re-synced "${connection.name}" (${available.length} tools)`);
        }
        // Normally a disarm/no-op (a re-sync only swaps an already-loaded
        // generation). When it ends with no loaded tools — e.g. it raced an idle
        // disconnect that a retry had revived — re-arming keeps the timer correct.
        reconcileIdleTimer(connection.name);
    }
    /**
     * Classify every `auto` server once: a small server is registered eagerly and
     * loses its loader; a multi-tool server keeps its loader.
     */
    async function probeServers() {
        // An explicit `lazy` server needs no classification, so it is never spawned
        // at startup; only `auto` and `eager` servers are.
        const entries = [...connections.values()].filter((connection) => (serverConfigs[connection.name].mode ?? 'auto') !== 'lazy');
        const settled = await Promise.allSettled(entries.map(async (connection) => ({ connection, discovered: await connection.listTools() })));
        for (const [index, result] of settled.entries()) {
            const connection = entries[index];
            if (result.status === 'rejected') {
                logger.warn(`[tool-aggregator] startup probe of "${connection.name}" failed: ${messageOf(result.reason)}; keeping its loader tool`);
                continue;
            }
            const { discovered } = result.value;
            const available = applyToolFilter(connection, discovered);
            if (available.length === 0) {
                disposeLoader(connection.name);
                if (discovered.length > 0) {
                    logger.info(`[tool-aggregator] "${connection.name}" exposes no tools (${discovered.length} tool(s) suppressed by disabledTools)`);
                }
                else {
                    logger.info(`[tool-aggregator] "${connection.name}" exposes no tools`);
                }
                continue;
            }
            const mode = serverConfigs[connection.name].mode ?? 'auto';
            const eager = mode === 'eager' || (mode === 'auto' && available.length <= singleToolThreshold);
            if (!eager) {
                logger.info(`[tool-aggregator] "${connection.name}": ${available.length} tools hidden behind loader "${loaderNameOf(connection.name)}"`);
                // The probe connected a server that stays behind its loader: when the
                // idle option is on, arm it so a never-loaded server is not warm forever.
                reconcileIdleTimer(connection.name);
                continue;
            }
            try {
                const generation = await loadServer(connection);
                disposeLoader(connection.name);
                logger.info(`[tool-aggregator] "${connection.name}": ${generation.disposers.size} tool(s) registered eagerly`);
            }
            catch (error) {
                logger.error(`[tool-aggregator] eager registration of "${connection.name}" failed: ${messageOf(error)}; keeping its loader tool`);
            }
        }
    }
    for (const connection of connections.values()) {
        connection.onToolsChanged(() => {
            void resync(connection);
        });
    }
    for (const serverName of Object.keys(serverConfigs))
        registerLoader(serverName);
    // A server loaded before an agent existed must still be masked for that agent,
    // and an agent that turns out to be a subagent of a holder must stay unmasked:
    // both are decided here, synchronously, before the agent's first request.
    ctx.on?.('agent/created', (payload) => {
        const agent = payload?.agent;
        const id = sessionIdOf(agent);
        if (id !== undefined)
            liveAgents.set(id, agent);
        syncAgent(agent);
    });
    // A disposed session must not keep holding a server open: its holder entries
    // are dropped, and a server left with no holder is released like any unload.
    ctx.on?.('agent/disposed', (payload) => {
        const agent = payload?.agent;
        forgetAgent(agent);
        const id = sessionIdOf(agent);
        if (id === undefined)
            return;
        for (const [serverName, set] of holders) {
            if (!set.delete(id))
                continue;
            if (set.size === 0) {
                unloadServer(serverName);
                continue;
            }
            syncAgents();
        }
    });
    ctx.effect(() => () => {
        for (const dispose of loaders.values()) {
            try {
                dispose();
            }
            catch {
                // Plugin teardown is best effort.
            }
        }
        loaders.clear();
        for (const generation of loaded.values()) {
            for (const dispose of generation.disposers.values()) {
                try {
                    dispose();
                }
                catch {
                    // Plugin teardown is best effort.
                }
            }
        }
        loaded.clear();
        pending.clear();
        for (const serverName of [...resourceDisposers.keys()])
            disposeResourceProvider(serverName);
        discoveryVersions.clear();
        landedVersions.clear();
        holders.clear();
        appliedMasks.clear();
        liveAgents.clear();
        for (const timer of idleTimers.values())
            clearTimeout(timer);
        idleTimers.clear();
        idleDisconnectCount.clear();
        for (const connection of connections.values())
            void connection.close();
        connections.clear();
        // Release this instance's claims so a remount of the same composition works.
        for (const serverName of Object.keys(serverConfigs))
            claimed.delete(serverName);
    }, 'tool-aggregator cleanup');
    if (probeAtStartup && connections.size > 0) {
        void probeServers().catch((error) => logger.error(`[tool-aggregator] startup probe failed: ${messageOf(error)}`));
    }
    logger.info(`[tool-aggregator] ${loaders.size} loader tool(s) registered: ${[...loaders.keys()].map(loaderNameOf).join(', ') || '(none)'}`);
}
export default { name, inject, apply };
//# sourceMappingURL=index.js.map