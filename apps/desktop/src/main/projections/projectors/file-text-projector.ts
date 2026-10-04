import type { ProjectionEvent, ProjectionProjector } from '../types'

/**
 * Tells text extraction that a filed PDF or image was indexed, so it compares
 * the file's bytes with the ones its stored text came from. A deleted note
 * needs no message: its extracted rows go with its `note_cache` row.
 */
export function createFileTextProjector(
  fileChanged: (noteId: string) => void
): ProjectionProjector {
  return {
    name: 'file-text',

    handles(event: ProjectionEvent): boolean {
      return event.type === 'note.upserted'
    },

    project(event: ProjectionEvent): void {
      if (event.type !== 'note.upserted' || event.note.kind !== 'file') return
      if (event.note.fileType === 'pdf' || event.note.fileType === 'image') {
        fileChanged(event.note.noteId)
      }
    },

    // Extraction rescans every file when it starts, which covers both.
    rebuild: () => undefined,
    reconcile: () => undefined
  }
}
