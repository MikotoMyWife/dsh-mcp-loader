/**
 * Built-in tool-description presets, merged from the retired
 * `trim-desktop-touch` plugin.
 *
 * The desktop-touch MCP server ships ~2.3 KB of description per tool, which is
 * what made the original plugin necessary. Here the override happens at
 * registration time — this plugin owns the tool definitions it registers, so it
 * needs no `system-prompt/assemble` rewrite.
 */
import type { ServerConfig } from './types.js';
/** Short English descriptions for the desktop-touch server's tools, keyed by raw MCP name. */
export declare const DESKTOP_TOUCH_DESCRIPTIONS: Readonly<Record<string, string>>;
/** Named presets a server may select through `descriptionPreset`. */
export declare const DESCRIPTION_PRESETS: Readonly<Record<string, Readonly<Record<string, string>>>>;
/** Parameter-description cap a preset implies unless the server overrides it. */
export declare const PRESET_PARAMETER_DESCRIPTION_CAP: Readonly<Record<string, number>>;
/** Resolve a server's description overrides from its explicit map and its preset. */
export declare function descriptionOverridesFor(config: ServerConfig): Readonly<Record<string, string>> | undefined;
//# sourceMappingURL=presets.d.ts.map