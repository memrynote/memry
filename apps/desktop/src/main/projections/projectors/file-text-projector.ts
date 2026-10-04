import type { ProjectionEvent, ProjectionProjector } from '../types'

/**
 * Tells text extraction that a note was indexed, so it compares that note's
 * files with the bytes its stored text came from: a filed PDF's or image's own
 * file, or the PDFs and images a markdown note embeds from its attachments
 * folder. A deleted note needs no message: its extracted rows go with its
 * `note_cache` row.
 */
export function createFileTextProjector(
  noteChanged: (noteId: string) => void
): ProjectionProjector {
  return {
    name: 'file-text',

    handles(event: ProjectionEvent): boolean {
      return event.type === 'note.upserted'
    },

    project(event: ProjectionEvent): void {
      if (event.type !== 'note.upserted') return
      const { note } = event
      if (note.kind === 'markdown' || note.fileType === 'pdf' || note.fileType === 'image') {
        noteChanged(note.noteId)
      }
    },

    // Extraction rescans every file when it starts, which covers both.
    rebuild: () => undefined,
    reconcile: () => undefined
  }
}
