/**
 * Built-in tool-description presets, merged from the retired
 * `trim-desktop-touch` plugin.
 *
 * The desktop-touch MCP server ships ~2.3 KB of description per tool, which is
 * what made the original plugin necessary. Here the override happens at
 * registration time — this plugin owns the tool definitions it registers, so it
 * needs no `system-prompt/assemble` rewrite.
 */
import type { ServerConfig } from './types.js'

/** Short English descriptions for the desktop-touch server's tools, keyed by raw MCP name. */
export const DESKTOP_TOUCH_DESCRIPTIONS: Readonly<Record<string, string>> = {
  desktop_state:
    'Observe desktop state: focused window/element, cursor, modal, attention signal. Cheap; use after each action to confirm state. Optional include* flags add cursor/screen/document/session info.',
  desktop_discover:
    'Find interactive entities (UIA/CDP/terminal/visual) in a window or tab and return a lease for desktop_act. view=action|explore|debug; query filters by label; maxEntities caps results.',
  desktop_act:
    'Act on an entity from desktop_discover: click/type/setValue/select/auto/invoke, using its lease. Validates lease; on ok:false read reason and recover (re-discover, dismiss blocker, re-focus window).',
  screenshot:
    'Capture desktop/window/region. detail=meta|text|image|som|ocr; windowTitle/hwnd targets a window; mode=background captures hidden windows; dotByDot gives 1:1 pixels; diffMode shows only changed windows; region crops.',
  screenshot_query:
    'List screenshots already in the on-disk cache (captureId, size, timestamp) without re-reading pixels. Filter by tag/windowUuid/time; page with limit/offset.',
  screenshot_gc:
    'Reclaim screenshot-cache disk space by retention policy (maxCount/maxTotalBytes/maxAgeMs). Default is a dry run; deletion needs dryRun:false AND confirm:true.',
  workspace_snapshot:
    'Orient fully in one call: display layouts, all window thumbnails, and per-window actionable elements with clickAt coords. Also resets the diffMode baseline.',
  server_status:
    'Return MCP server status: native engine availability (uia/imageDiff backend) and process health (uptime/memory/cpu). Diagnostic info.',
  keyboard:
    'Send keyboard input. action=type (text, auto-clipboard for non-ASCII), press (key combos like ctrl+c), sequence (atomic multi-step). windowTitle auto-focuses and guards the target.',
  mouse_click:
    'Click at screen coordinates. Pass windowTitle to auto-guard (identity/foreground/coordinate checks); origin+scale work with dotByDot screenshots; doubleClick/tripleClick supported.',
  mouse_drag:
    'Click-and-drag with left button from (startX,startY) to (endX,endY). For sliders, drag-and-drop, canvas drawing. windowTitle guards the start coordinate. Cross-window drags blocked by default.',
  scroll:
    'Scroll a window/page. action=raw (wheel notches), to_element (named element into view), smart (auto-detect), capture (stitched full-page image), read (scroll+OCR+dedupe to stitched text).',
  click_element:
    'UIA InvokePattern click by element name/automationId — no coordinates needed. windowTitle required. Fall back to mouse_click when InvokePattern is unsupported.',
  browser_open:
    'Connect to Chrome/Edge CDP (port 9222) and return open tabs. Pass launch:{} to auto-spawn a debug-mode browser when no endpoint is live. Required before other browser_* tools.',
  browser_navigate:
    'Navigate a browser tab to a URL via CDP. Does not block for full load; follow with wait_until or polling for slow pages. Pass tabId+port for auto-guard.',
  browser_click:
    'Click a DOM element in Chrome/Edge. Target via CSS selector, or semantically by text/regex/role/ariaLabel + pattern. Auto-guards tab identity; stops (never clicks) on ambiguous or modal-blocked targets.',
  browser_fill:
    'Fill a form input (works on React/Vue controlled inputs). Target via CSS selector or by text/regex/role/ariaLabel. Verifies the value actually landed.',
  browser_form:
    'Inspect all form fields (input/select/textarea/button) inside a container selector: name, type, id, value, hint, disabled state, label. Use before browser_fill.',
  browser_eval:
    'Inspect/operate a browser tab. action=js (run expression), dom (get HTML), appState (extract SSR-injected SPA state). withPerception wraps result with post-observation.',
  browser_overview:
    'List all interactive elements (links/buttons/inputs) with CSS selectors, text/value, viewport status, and ARIA state. Also reports whether a modal is blocking. scope limits the area.',
  browser_search:
    'Grep-like element search by text/regex/role/ariaLabel/selector. Returns matches sorted by confidence with selectors you can pass to browser_click.',
  browser_locate:
    'Find a DOM element by CSS selector and return its physical screen coordinates, compatible with mouse_click.',
  terminal:
    'Interact with a terminal window. action=run (send+wait+read in one call), read (structured output, sinceMarker for diffs), send (send input). until={mode:quiet|pattern|exit} controls completion.',
  wait_until:
    'Server-side poll for a condition: window_appears/disappears, focus_changes, element_appears/value_changes, ready_state, terminal_output_contains, element_matches, url_matches. No screenshot-polling loops.',
  window_dock:
    'Decorate a window: pin (always-on-top), unpin, or dock (move+resize to a corner, optionally pin). Minimized windows are restored before docking.',
  focus_window:
    'Bring a window to the foreground by partial title match (case-insensitive). chromeTabUrlContains activates a specific Chrome tab first. Returns WindowNotFound if no match.',
  workspace_launch:
    'Launch an application and wait for its new window to appear (HWND-based detection, localized titles OK). Returns windowTitle/hwnd/pid.',
  run_macro:
    'Execute multiple tools sequentially in one MCP call to cut round-trip latency (max 50 steps, stop_on_error default true). Use only for predictable fixed sequences.',
  clipboard:
    'Read or write the Windows clipboard. write verifies delivery by byte-comparing the read-back; oversized writes refuse cleanly. Writes overwrite existing content.',
  notification_show:
    'Show a Windows system tray balloon notification to alert the user. Use at the end of a long-running task.',
  key_locker:
    'Manage credentials the terminal autofills (SSH passphrases, sudo/login passwords). save/list/forget/set_policy/status manage bindings; launch_console opens an autofill-capable pane. Secrets never shown to the assistant.',
  excel:
    'Author and run Excel VBA macros via COM. action=run_vba runs a Sub from trusted location; check_access_vbom is a read-only preflight. Requires one-time trust setup.',
}

/** Named presets a server may select through `descriptionPreset`. */
export const DESCRIPTION_PRESETS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'desktop-touch': DESKTOP_TOUCH_DESCRIPTIONS,
}

/** Parameter-description cap a preset implies unless the server overrides it. */
export const PRESET_PARAMETER_DESCRIPTION_CAP: Readonly<Record<string, number>> = {
  'desktop-touch': 90,
}

/** Resolve a server's description overrides from its explicit map and its preset. */
export function descriptionOverridesFor(config: ServerConfig): Readonly<Record<string, string>> | undefined {
  const preset = config.descriptionPreset === undefined ? undefined : DESCRIPTION_PRESETS[config.descriptionPreset]
  if (config.descriptionPreset !== undefined && preset === undefined) {
    throw new Error(
      `unknown descriptionPreset ${JSON.stringify(config.descriptionPreset)}; known presets: ${Object.keys(DESCRIPTION_PRESETS).join(', ')}`,
    )
  }
  if (preset === undefined) return config.toolDescriptions
  return { ...preset, ...config.toolDescriptions }
}
