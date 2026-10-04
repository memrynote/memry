import { describe, expect, it } from 'vitest'
import type { FileNoteProjection } from '../types'
import { createFileTextProjector } from './file-text-projector'

function fileEvent(noteId: string, fileType: FileNoteProjection['fileType']) {
  return {
    type: 'note.upserted' as const,
    note: {
      kind: 'file' as const,
      noteId,
      path: `files/${noteId}`,
      title: noteId,
      fileType,
      mimeType: null,
      fileSize: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:00:00.000Z'
    }
  }
}

describe('file text projector', () => {
  it('passes on filed PDFs and images, and no other file type', async () => {
    const changed: string[] = []
    const projector = createFileTextProjector((noteId) => changed.push(noteId))

    for (const event of [
      fileEvent('scan', 'pdf'),
      fileEvent('photo', 'image'),
      fileEvent('memo', 'audio'),
      fileEvent('clip', 'video')
    ]) {
      await projector.project(event)
    }
    await projector.project({ type: 'note.deleted', noteId: 'scan' })

    expect(changed).toEqual(['scan', 'photo'])
    expect(projector.handles({ type: 'note.deleted', noteId: 'scan' })).toBe(false)
    expect(projector.handles(fileEvent('scan', 'pdf'))).toBe(true)
  })
})
