/** Credential-shaped environment names; the same pattern the harness scrubs with. */
export const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i;
/** Harness-private facts (proxy policy, sandbox wiring, tokens) never reach a child. */
export const DSH_ENV_PREFIX = 'DSH_';
/** Whether a child Node accepts this value under `NODE_USE_ENV_PROXY`. */
function isHttpProxyUrl(value) {
    return /^https?:\/\//i.test(value);
}
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
export function childEnv(extra) {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined)
            continue;
        if (SENSITIVE_ENV_PATTERN.test(key))
            continue;
        if (key.toUpperCase().startsWith(DSH_ENV_PREFIX))
            continue;
        env[key] = value;
    }
    const httpProxy = env.HTTP_PROXY ?? env.http_proxy;
    const httpsProxy = env.HTTPS_PROXY ?? env.https_proxy;
    const proxies = [httpProxy, httpsProxy].filter((value) => value !== undefined);
    if (env.NODE_USE_ENV_PROXY === undefined && proxies.length > 0 && proxies.every(isHttpProxyUrl)) {
        env.NODE_USE_ENV_PROXY = '1';
    }
    return { ...env, ...extra };
}
//# sourceMappingURL=env.js.map