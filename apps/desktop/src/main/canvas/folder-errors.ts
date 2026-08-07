/**
 * Typed canvas-folder failures.
 *
 * Its own module, and a leaf one, because both ends of the folder stack raise
 * these: `folder-paths` (pure path algebra) rejects a name and a depth, and
 * `folder-store` rejects a collision, a cycle and an fs failure. Keeping the
 * class in `folder-store` would have made `folder-paths` import its own
 * importer.
 *
 * @module canvas/folder-errors
 */

export const CanvasFolderErrorCode = {
  /** The destination is already taken by a folder or a directory. */
  EXISTS: 'CANVAS_FOLDER_EXISTS',
  /** The move would nest a folder inside its own subtree. */
  DESCENDANT: 'CANVAS_FOLDER_DESCENDANT',
  /** The directory could not be moved (locked, gone, permissions). */
  MOVE_FAILED: 'CANVAS_FOLDER_MOVE_FAILED',
  /** The result would nest past MAX_CANVAS_FOLDER_DEPTH. */
  DEPTH: 'CANVAS_FOLDER_DEPTH',
  /** The name is empty once trimmed, or is nothing but traversal segments. */
  INVALID_NAME: 'CANVAS_FOLDER_INVALID_NAME'
} as const

export type CanvasFolderErrorCode =
  (typeof CanvasFolderErrorCode)[keyof typeof CanvasFolderErrorCode]

/**
 * A canvas-folder failure the user can actually cause, typed so the IPC layer
 * can turn it into a translated string.
 *
 * The message carries neither the folder name nor a path: folder names are user
 * content, and a raw `fs` error is worse still — `renameSync` reports ENOTEMPTY
 * with BOTH absolute paths in its text, which would put the user's vault
 * location in the UI and in telemetry. The originating error is kept on `cause`
 * for the log, never for the renderer.
 *
 * The English message is a fallback for logs and for a caller outside the IPC
 * layer. What the renderer receives is the i18n key the code maps to — see
 * `CANVAS_FOLDER_ERROR_KEYS` in `ipc/canvas-folder-handlers`.
 */
export class CanvasFolderError extends Error {
  constructor(
    message: string,
    public code: CanvasFolderErrorCode,
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = 'CanvasFolderError'
  }
}
