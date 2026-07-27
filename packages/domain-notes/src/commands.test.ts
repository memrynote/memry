import { describe, expect, it } from 'vitest'
import { buildCanonicalNoteMetadata, resolveNoteSyncPolicy } from './commands'

describe('domain-notes commands', () => {
  it('derives canonical property definition references from note properties', () => {
    const result = buildCanonicalNoteMetadata({
      id: 'note-1',
      path: 'notes/ideas/test.md',
      title: 'Test',
      createdAt: '2026-04-08T10:00:00.000Z',
      modifiedAt: '2026-04-08T10:05:00.000Z',
      properties: {
        mood: 'focused',
        priority: 2
      }
    })

    expect(result.propertyDefinitionNames).toEqual(['mood', 'priority'])
    expect(result.syncPolicy).toBe('sync')
  })

  it('maps local-only notes to the canonical local-only sync policy', () => {
    expect(resolveNoteSyncPolicy(true)).toBe('local-only')
    expect(resolveNoteSyncPolicy(false)).toBe('sync')
  })

  it('leaves sync bookkeeping untouched when the caller does not supply it', () => {
    // Vault saves (content edit, rename, move, re-index) call this with file
    // state only. Materialising `null` here reaches upsertNoteMetadata's
    // onConflictDoUpdate and ERASES the row's attachment references, so the
    // note's embedded images/PDFs stop being announced to other devices after
    // the first edit. Absent must stay absent so the stored value survives.
    const result = buildCanonicalNoteMetadata({
      id: 'note-1',
      path: 'notes/test.md',
      title: 'Test',
      createdAt: '2026-04-08T10:00:00.000Z',
      modifiedAt: '2026-04-08T10:05:00.000Z'
    })

    expect(result.attachmentReferences).toBeUndefined()
    expect(result.attachmentId).toBeUndefined()
    expect(result.syncedAt).toBeUndefined()
    expect(result.clock).toBeUndefined()
  })

  it('still writes the values the caller does supply, including explicit clears', () => {
    const set = buildCanonicalNoteMetadata({
      id: 'note-1',
      path: 'notes/test.md',
      title: 'Test',
      createdAt: '2026-04-08T10:00:00.000Z',
      modifiedAt: '2026-04-08T10:05:00.000Z',
      attachmentId: 'att-1',
      syncedAt: '2026-04-08T10:06:00.000Z'
    })
    expect(set.attachmentId).toBe('att-1')
    // attachmentId still seeds the reference list when none was passed
    expect(set.attachmentReferences).toEqual(['att-1'])
    expect(set.syncedAt).toBe('2026-04-08T10:06:00.000Z')

    const cleared = buildCanonicalNoteMetadata({
      id: 'note-1',
      path: 'notes/test.md',
      title: 'Test',
      createdAt: '2026-04-08T10:00:00.000Z',
      modifiedAt: '2026-04-08T10:05:00.000Z',
      attachmentReferences: null,
      attachmentId: null,
      syncedAt: null
    })
    expect(cleared.attachmentReferences).toBeNull()
    expect(cleared.attachmentId).toBeNull()
    expect(cleared.syncedAt).toBeNull()
  })
})
