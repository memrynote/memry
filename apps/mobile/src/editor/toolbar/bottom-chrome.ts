import type { ToolbarAction } from '@memry/contracts/webview-bridge'

/**
 * What sits under the editor WebView, decided in one place.
 *
 * The WebView's frame ENDS where this chrome begins, so the keyboard never
 * overlaps the document and WebKit's visual viewport never diverges from its
 * layout viewport (#2131). Everything below is a pure function of a few facts
 * the host already holds; nothing here reads the DOM or the keyboard.
 */

export type ToolbarRow = 'main' | 'formatting'

export type ToolbarPanel = 'blocks' | 'turn-into' | 'table' | 'style' | 'link-prompt'

/** The chrome to draw. `panel` replaces the keyboard; `toolbar` sits on it. */
export type BottomChrome =
  | { kind: 'hidden' }
  | { kind: 'toolbar'; row: ToolbarRow }
  | { kind: 'panel'; panel: ToolbarPanel; row: ToolbarRow }

/**
 * The remembered state. `row` outlives a hide, so a reader who was on the
 * formatting row, hid the keyboard and tapped back finds the same row.
 */
export interface BottomChromeModel {
  row: ToolbarRow
  panel: ToolbarPanel | null
  keyboardUp: boolean
  editorFocused: boolean
  readOnly: boolean
  /** A guest panel (find-in-note, the date sheet) holds the strip instead. */
  suppressed: boolean
}

export const INITIAL_BOTTOM_CHROME: BottomChromeModel = {
  row: 'main',
  panel: null,
  keyboardUp: false,
  editorFocused: false,
  readOnly: false,
  suppressed: false
}

export type BottomChromeEvent =
  | { type: 'keyboard'; up: boolean }
  | { type: 'editor-focus'; focused: boolean }
  | { type: 'read-only'; readOnly: boolean }
  | { type: 'suppressed'; suppressed: boolean }
  | { type: 'show-row'; row: ToolbarRow }
  | { type: 'open-panel'; panel: ToolbarPanel }
  | { type: 'close-panel' }
  /** The caret moved; the table panel only makes sense while it is in a table. */
  | { type: 'caret'; inTable: boolean }
  /** The guest was handed another note: nothing about this one carries over. */
  | { type: 'reset' }

/** The row each panel opens from, and returns to. */
export const PANEL_ROW: Readonly<Record<ToolbarPanel, ToolbarRow>> = {
  blocks: 'main',
  table: 'main',
  'turn-into': 'formatting',
  style: 'formatting',
  'link-prompt': 'formatting'
}

export function reduceBottomChrome(
  model: BottomChromeModel,
  event: BottomChromeEvent
): BottomChromeModel {
  switch (event.type) {
    case 'keyboard': {
      // A panel took the keyboard's place, so the keyboard coming back means
      // the reader tapped into the note: the panel gives the space back rather
      // than stacking under the keyboard. The link prompt is the exception; its
      // own field is what holds the keyboard up.
      const closes =
        event.up && !model.keyboardUp && model.panel !== null && model.panel !== 'link-prompt'
      return { ...model, keyboardUp: event.up, panel: closes ? null : model.panel }
    }
    case 'editor-focus':
      return { ...model, editorFocused: event.focused }
    case 'read-only':
      return event.readOnly
        ? { ...model, readOnly: true, panel: null, row: 'main' }
        : { ...model, readOnly: false }
    case 'suppressed':
      return { ...model, suppressed: event.suppressed }
    case 'show-row':
      return model.panel === null ? { ...model, row: event.row } : model
    case 'open-panel':
      return model.readOnly ? model : { ...model, panel: event.panel, row: PANEL_ROW[event.panel] }
    case 'close-panel':
      return { ...model, panel: null }
    case 'caret':
      return !event.inTable && model.panel === 'table' ? { ...model, panel: null } : model
    case 'reset':
      return { ...INITIAL_BOTTOM_CHROME, keyboardUp: model.keyboardUp, readOnly: model.readOnly }
    default: {
      const _exhaustive: never = event
      return _exhaustive
    }
  }
}

export function bottomChromeOf(model: BottomChromeModel): BottomChrome {
  if (model.readOnly || model.suppressed) return { kind: 'hidden' }
  if (model.panel !== null) return { kind: 'panel', panel: model.panel, row: model.row }
  if (model.editorFocused && model.keyboardUp) return { kind: 'toolbar', row: model.row }
  return { kind: 'hidden' }
}

/**
 * The panel's height when no keyboard has been measured yet on this launch.
 * Roughly the iPhone portrait keyboard; the real value replaces it the first
 * time one comes up.
 */
export const FALLBACK_PANEL_HEIGHT = 336

/**
 * What the native toolbar can ask of the host.
 *
 * `openPanel` and `closePanel` change what is drawn; `act` is forwarded to the
 * guest verbatim. Opening any panel but the link prompt also asks the guest to
 * blur, which is what sends the keyboard away so the panel can take its place.
 */
export interface ToolbarIntents {
  showRow(row: ToolbarRow): void
  openPanel(panel: ToolbarPanel): void
  closePanel(): void
  act(action: ToolbarAction): void
}
