import { ServerConnection, messageOf, validateServerConfig } from './connection.js';
import { PRESET_PARAMETER_DESCRIPTION_CAP, descriptionOverridesFor } from './presets.js';
/** Appended to every loader tool description unless overridden by config. */
const DEFAULT_LOADER_HINT = "Call to load this MCP server's tools; call again to hide them.";
/** Loader metadata: the plugin owns no service, but it must not apply before the registry. */
export const name = 'tool-aggregator';
/** Cordis dependency: the tool registry must exist before this plugin applies. */
export const inject = ['tools'];
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
        if (problems.length > 0)
            throw new Error(`tool-aggregator: server "${serverName}": ${problems.join('; ')}`);
        // Fail fast on an unknown description preset instead of at first load.
        descriptionOverridesFor(serverConfig);
    }
    const found = ctx.get('tools');
    if (found === undefined) {
        throw new Error('tool-aggregator requires @deepseek-ai/dsh-tools (ctx.tools) in the composition');
    }
    /** Non-optional binding so closures see the narrowed type. */
    const registry = found;
    const connections = new Map();
    for (const [serverName, serverConfig] of Object.entries(serverConfigs)) {
        connections.set(serverName, new ServerConnection(serverName, serverConfig, logger, config.connectTimeoutMs));
    }
    /** server name -> loader tool registration disposer */
    const loaders = new Map();
    /** server name -> raw tool name -> registration disposer (the live generation) */
    const loaded = new Map();
    /** server name -> in-flight load, so the startup probe and a loader call cannot double-register */
    const pending = new Map();
    /**
     * server name -> public tool names hidden from every agent once that server is
     * loaded. Merged from the retired `inkstone-tool-hide` plugin: the mask is a
     * per-agent `restrict()`, which only filters inherited (global) tools — which
     * is why this plugin registers globally.
     */
    const hiddenTools = new Map();
    for (const [serverName, serverConfig] of Object.entries(serverConfigs)) {
        const names = (serverConfig.hiddenTools ?? []).map((name) => name.startsWith('mcp__') ? name : `mcp__${serverName}__${name}`);
        if (names.length > 0)
            hiddenTools.set(serverName, names);
    }
    /** agent -> servers whose deny mask that agent already carries (weak: no retention). */
    const restricted = new WeakMap();
    /** Apply every ready server's deny mask to one agent, once per server. */
    function restrictAgent(agent) {
        if (typeof agent !== 'object' || agent === null)
            return;
        let done = restricted.get(agent);
        if (done === undefined) {
            done = new Set();
            restricted.set(agent, done);
        }
        for (const [serverName, names] of hiddenTools) {
            if (done.has(serverName))
                continue;
            if ((loaded.get(serverName)?.size ?? 0) === 0)
                continue;
            const agentTools = agent
                .ctx?.tools;
            if (agentTools?.restrict === undefined)
                continue;
            try {
                agentTools.restrict({ deny: names });
                done.add(serverName);
                logger.info(`[tool-aggregator] hid ${names.length} tool(s) of "${serverName}" from one agent`);
            }
            catch (error) {
                logger.warn(`[tool-aggregator] could not hide tools of "${serverName}" from an agent: ${messageOf(error)}`);
            }
        }
    }
    /** Apply the masks to the calling agent and every agent the harness knows about. */
    function restrictAllAgents(caller) {
        restrictAgent(caller);
        const agents = ctx.get('agents');
        for (const agent of agents?.list?.() ?? [])
            restrictAgent(agent);
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
    const loaderNameOf = (serverName) => serverConfigs[serverName].loaderName ?? `mcp_${serverName}`;
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
        const next = new Map();
        try {
            for (const tool of discovered)
                next.set(tool.rawName, registry.register(definitionFor(connection, tool)));
        }
        catch (error) {
            for (const dispose of next.values()) {
                try {
                    dispose();
                }
                catch {
                    // Rollback is best effort; nothing from this generation survives.
                }
            }
            throw error;
        }
        return next;
    }
    /** Load one server's tools, deduplicating concurrent attempts. */
    function loadServer(connection, caller) {
        const existing = loaded.get(connection.name);
        if (existing !== undefined && existing.size > 0)
            return Promise.resolve(existing);
        const inflight = pending.get(connection.name);
        if (inflight !== undefined)
            return inflight;
        const attempt = (async () => {
            const discovered = await connection.listTools();
            if (discovered.length === 0) {
                const empty = new Map();
                loaded.set(connection.name, empty);
                return empty;
            }
            const generation = registerGeneration(connection, discovered);
            loaded.set(connection.name, generation);
            restrictAllAgents(caller);
            logger.info(`[tool-aggregator] loaded ${generation.size} tool(s) from "${connection.name}"`);
            return generation;
        })().finally(() => {
            pending.delete(connection.name);
        });
        pending.set(connection.name, attempt);
        return attempt;
    }
    /** Hide a loaded server's tools again; returns how many registrations were released. */
    function unloadServer(serverName) {
        const generation = loaded.get(serverName);
        if (generation === undefined)
            return 0;
        loaded.delete(serverName);
        for (const dispose of generation.values()) {
            try {
                dispose();
            }
            catch (error) {
                logger.warn(`[tool-aggregator] disposing a tool of "${serverName}" failed: ${messageOf(error)}`);
            }
        }
        return generation.size;
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
                const current = loaded.get(connection.name);
                if (current !== undefined && current.size > 0) {
                    const removed = unloadServer(connection.name);
                    return { text: `ok (${removed} tool(s) hidden)` };
                }
                await loadServer(connection, exec.agent);
                return { text: 'ok' };
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
    }
    /** Replace the live generation for a server after its tool list changed. */
    function swapGeneration(connection, discovered) {
        const previous = loaded.get(connection.name);
        if (previous === undefined || previous.size === 0)
            return;
        for (const dispose of previous.values()) {
            try {
                dispose();
            }
            catch (error) {
                logger.warn(`[tool-aggregator] disposing a tool of "${connection.name}" failed: ${messageOf(error)}`);
            }
        }
        try {
            loaded.set(connection.name, registerGeneration(connection, discovered));
        }
        catch (error) {
            loaded.delete(connection.name);
            logger.error(`[tool-aggregator] re-sync of "${connection.name}" could not re-register its tools: ${messageOf(error)}; that server is now unloaded`);
        }
    }
    async function resync(connection) {
        let discovered;
        try {
            discovered = await connection.listTools(true);
        }
        catch (error) {
            logger.warn(`[tool-aggregator] re-sync of "${connection.name}" failed: ${messageOf(error)}`);
            return;
        }
        swapGeneration(connection, discovered);
        logger.info(`[tool-aggregator] re-synced "${connection.name}" (${discovered.length} tools)`);
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
            if (discovered.length === 0) {
                disposeLoader(connection.name);
                logger.info(`[tool-aggregator] "${connection.name}" exposes no tools`);
                continue;
            }
            const mode = serverConfigs[connection.name].mode ?? 'auto';
            const eager = mode === 'eager' || (mode === 'auto' && discovered.length <= singleToolThreshold);
            if (!eager) {
                logger.info(`[tool-aggregator] "${connection.name}": ${discovered.length} tools hidden behind loader "${loaderNameOf(connection.name)}"`);
                continue;
            }
            try {
                await loadServer(connection);
                disposeLoader(connection.name);
                logger.info(`[tool-aggregator] "${connection.name}": ${discovered.length} tool(s) registered eagerly`);
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
    // An agent created after a masked server was loaded still needs its deny mask.
    ctx.on?.('agent/created', (payload) => restrictAgent(payload?.agent));
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
            for (const dispose of generation.values()) {
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
        for (const connection of connections.values())
            void connection.close();
        connections.clear();
    }, 'tool-aggregator cleanup');
    if (probeAtStartup && connections.size > 0) {
        void probeServers().catch((error) => logger.error(`[tool-aggregator] startup probe failed: ${messageOf(error)}`));
    }
    logger.info(`[tool-aggregator] ${loaders.size} loader tool(s) registered: ${[...loaders.keys()].map(loaderNameOf).join(', ') || '(none)'}`);
}
export default { name, inject, apply };
//# sourceMappingURL=index.js.map