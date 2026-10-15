/**
 * Ask the notes tree to reveal a note: expand every folder on its path, scroll
 * it into view and flash it.
 *
 * A window event rather than a callback, because the surfaces that create notes
 * (the app menu, the sidebar's "+", the tab bar's "+") are nowhere near the tree
 * in the component graph, and the note's folder is only known from the created
 * note's own path — with "create in selected folder" off, the destination is
 * resolved by the main process from `defaultNoteFolder`.
 */
export const revealNoteInSidebar = (noteId: string): void => {
  window.dispatchEvent(
    new CustomEvent('reveal-in-sidebar', {
      detail: { path: `/notes/${noteId}`, entityId: noteId }
    })
  )
}
