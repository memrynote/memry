/**
 * Custom drag data type set when any note or file item is dragged out of the
 * left sidebar (`VirtualizedNotesTree`). The payload is the item's note id.
 *
 * Consumers:
 * - the note editor embeds a *file* item by its own vault path
 *   (`window.api.notes.getFile(id)`; a markdown note resolves to null → no-op);
 * - a sidebar project drop links the item to the project (file vs note is
 *   resolved via `getFile`).
 */
export const MEMRY_NOTE_DRAG_MIME = 'application/x-memry-note'

/**
 * Set next to BlockNote's own drag data when a single task block is dragged by
 * its side-menu handle. The payload is the task id. The day panel timeline and
 * its Unscheduled list schedule that task on drop and leave the block in the
 * note.
 */
export const MEMRY_TASK_DRAG_MIME = 'application/x-memry-task'
