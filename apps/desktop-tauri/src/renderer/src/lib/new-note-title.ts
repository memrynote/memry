/**
 * A "new note" gesture creates the file as `New note` (the vault numbers a clash
 * `New note 1`, ...) and opens it with the title field empty and focused, so the
 * user types the name from the first character instead of deleting a default.
 * Blurring with nothing typed keeps the file's real name.
 *
 * Module state rather than tab data: the creating surfaces (⌘N, sidebar "+",
 * tab bar "+", home, folder view) are far from the note page in the component
 * graph, and the mark only has to survive until that page first renders.
 */
export const NEW_NOTE_TITLE = 'New note'

const pendingTitleFocus = new Set<string>()

export const markNewNoteTitlePending = (noteId: string): void => {
  pendingTitleFocus.add(noteId)
}

export const isNewNoteTitlePending = (noteId: string): boolean => pendingTitleFocus.has(noteId)

export const clearNewNoteTitlePending = (noteId: string): void => {
  pendingTitleFocus.delete(noteId)
}
