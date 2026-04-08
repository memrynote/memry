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
})
