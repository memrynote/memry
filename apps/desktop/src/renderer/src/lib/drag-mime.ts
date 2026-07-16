/**
 * Custom drag data type used when a file-type item is dragged out of the left
 * sidebar (`VirtualizedNotesTree`) so the note editor can distinguish it from a
 * plain text drag or an OS file drop and embed the item by its own vault path
 * (no copy into `attachments/`).
 *
 * The payload is the item's note id; the editor resolves it to an absolute path
 * via `window.api.notes.getFile(id)`.
 */
export const MEMRY_NOTE_DRAG_MIME = 'application/x-memry-note'
