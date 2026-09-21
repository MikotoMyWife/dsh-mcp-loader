/**
 * The environment handed to one MCP stdio child process.
 *
 * Mirrors the semantics of the harness' `scrubbedParentEnv()` — every
 * credential-shaped key and every `DSH_*` fact is withheld — without taking a
 * runtime dependency on `@deepseek-ai/dsh-subprocess`: the plugin stays
 * self-contained and owns this definition. Unlike the MCP SDK's minimal default
 * environment, this keeps the parent's real environment (PATH, `NPM_CONFIG_*`,
 * and the proxy variables a `npx`-based server needs), which is what a server
 * started through `npx`/`mcp-remote` actually depends on. The plugin's own
 * `env` config merges last, so an explicit value always wins.
 */
import type { ServerConfig } from './types.js';
/** Credential-shaped environment names; the same pattern the harness scrubs with. */
export declare const SENSITIVE_ENV_PATTERN: RegExp;
/** Harness-private facts (proxy policy, sandbox wiring, tokens) never reach a child. */
export declare const DSH_ENV_PREFIX = "DSH_";
/**
 * Build the child environment: the scrubbed parent environment, the proxy
 * variables it already carries, the `NODE_USE_ENV_PROXY` flag a child Node needs
 * to honor them, and finally the configured `env` overlay.
 *
 * The flag is withheld when any proxy value present is not an `http:`/`https:`
 * URL: Node parses `HTTP(S)_PROXY` before running the program and exits on any
 * other scheme, so a SOCKS value kept for `curl` must not stop a Node child from
 * starting.
 */
export declare function childEnv(extra: ServerConfig['env']): Record<string, string>;
//# sourceMappingURL=env.d.ts.map