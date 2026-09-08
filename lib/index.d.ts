import type { PluginConfig } from './types.js';
/** Loader metadata: the plugin owns no service, but it must not apply before the registry. */
export declare const name = "tool-aggregator";
/** Cordis dependency: the tool registry must exist before this plugin applies. */
export declare const inject: string[];
export declare function apply(ctx: any, config?: PluginConfig): void;
declare const _default: {
    name: string;
    inject: string[];
    apply: typeof apply;
};
export default _default;
//# sourceMappingURL=index.d.ts.map