/**
 * The few values both canvas-tree rows need. A leaf module because
 * `canvas-tree` imports the rows, so the rows cannot import it back.
 *
 * @module components/sidebar/canvas-tree/folder-options
 */

/** Indent step per tree level, in px. Applied as `paddingInlineStart`, never left. */
export const CANVAS_ROW_INDENT_PX = 12

/** One entry in the "Move to folder" submenu. */
export interface CanvasFolderOption {
  /** Path relative to `canvases/`, forward-slashed — what gets stored. */
  path: string
  /** Last segment, as stored. The label; `depth` supplies the hierarchy. */
  name: string
  depth: number
}

/**
 * Whether two stored folder paths name the same folder.
 *
 * Same NFC + lowercase key `canvas-tree-model` and `main/canvas/folder-paths`
 * use, and for the same reason: macOS stores filenames decomposed and both
 * macOS and Windows are case-insensitive, so `work` and `Work` are one
 * directory. Used only to grey out the folder a canvas already sits in — a
 * mismatch here would offer a move that changes nothing.
 */
export function isSameCanvasFolder(a: string | null, b: string | null): boolean {
  return (a ?? '').normalize('NFC').toLowerCase() === (b ?? '').normalize('NFC').toLowerCase()
}
