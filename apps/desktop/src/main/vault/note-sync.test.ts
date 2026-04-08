import { describe, it, expect, vi } from 'vitest'
import { createMockDb } from '@tests/utils/type-safe-mocks'

vi.mock('@main/database/queries/notes', () => ({
  insertNoteCache: vi.fn(),
  updateNoteCache: vi.fn(),
  deleteNoteCache: vi.fn(),
  setNoteTags: vi.fn(),
  setNoteLinks: vi.fn(),
  setNoteProperties: vi.fn(),
  getPropertyType: vi.fn(),
  deleteLinksToNote: vi.fn(),
  extractDateFromPath: vi.fn(() => null),
  resolveNotesByTitles: vi.fn(() => new Map()),
  getNoteCacheByPath: vi.fn(() => undefined)
}))

vi.mock('../database', () => ({
  queueFtsUpdate: vi.fn(),
  getDatabase: vi.fn(() => createMockDb())
}))

vi.mock('@memry/domain-notes', () => ({
  saveCanonicalNote: vi.fn(),
  saveCanonicalPropertyDefinition: vi.fn(),
  deleteCanonicalNote: vi.fn()
}))

import { extractNoteMetadata, syncNoteToCache, type NoteSyncInput } from './note-sync'
import { setNoteTags } from '@main/database/queries/notes'
import { saveCanonicalNote } from '@memry/domain-notes'
import type { NoteFrontmatter } from './frontmatter'

const FIXED_ISO = '2026-01-15T12:00:00.000Z'

function buildInput(overrides: Partial<NoteSyncInput> = {}): NoteSyncInput {
  const frontmatter: NoteFrontmatter = {
    id: 'abc123def456',
    created: FIXED_ISO,
    modified: FIXED_ISO,
    tags: [],
    ...(overrides.frontmatter ?? {})
  }

  return {
    id: frontmatter.id,
    path: overrides.path ?? 'notes/test.md',
    fileContent: overrides.fileContent ?? '---\n---\n' + (overrides.parsedContent ?? ''),
    parsedContent: overrides.parsedContent ?? '',
    frontmatter
  }
}

describe('extractNoteMetadata', () => {
  describe('tag merging (frontmatter + inline)', () => {
    it('returns frontmatter-only tags when no inline tags exist', () => {
      // #given
      const input = buildInput({
        frontmatter: {
          id: 'abc123def456',
          created: FIXED_ISO,
          modified: FIXED_ISO,
          tags: ['work', 'personal']
        },
        parsedContent: 'No tags here'
      })

      // #when
      const result = extractNoteMetadata(input)

      // #then
      expect(result.tags).toEqual(['work', 'personal'])
    })

    it('returns inline-only tags when frontmatter has no tags', () => {
      // #given
      const input = buildInput({
        parsedContent: 'Hello #world and #typescript'
      })

      // #when
      const result = extractNoteMetadata(input)

      // #then
      expect(result.tags).toEqual(['world', 'typescript'])
    })

    it('merges frontmatter and inline tags without duplicates', () => {
      // #given
      const input = buildInput({
        frontmatter: {
          id: 'abc123def456',
          created: FIXED_ISO,
          modified: FIXED_ISO,
          tags: ['work', 'coding']
        },
        parsedContent: 'Some #coding notes with #react'
      })

      // #when
      const result = extractNoteMetadata(input)

      // #then
      expect(result.tags).toContain('work')
      expect(result.tags).toContain('coding')
      expect(result.tags).toContain('react')
      expect(result.tags.filter((t) => t === 'coding')).toHaveLength(1)
    })

    it('returns empty array when no tags anywhere', () => {
      const input = buildInput({ parsedContent: 'Plain text with no tags' })
      expect(extractNoteMetadata(input).tags).toEqual([])
    })

    it('ignores inline tags inside code blocks', () => {
      const input = buildInput({
        parsedContent: '#real tag\n```\n#fake\n```'
      })

      expect(extractNoteMetadata(input).tags).toEqual(['real'])
    })

    it('normalizes all tags to lowercase', () => {
      const input = buildInput({
        frontmatter: {
          id: 'abc123def456',
          created: FIXED_ISO,
          modified: FIXED_ISO,
          tags: ['Work']
        },
        parsedContent: 'Also #URGENT'
      })

      expect(extractNoteMetadata(input).tags).toEqual(['work', 'urgent'])
    })

    it('deduplicates case-insensitive matches across sources', () => {
      const input = buildInput({
        frontmatter: {
          id: 'abc123def456',
          created: FIXED_ISO,
          modified: FIXED_ISO,
          tags: ['React']
        },
        parsedContent: 'Using #react in this note'
      })

      expect(extractNoteMetadata(input).tags).toEqual(['react'])
    })
  })
})

describe('syncNoteToCache — tagsOverride', () => {
  it('uses tagsOverride instead of re-extracting inline tags from stale content', () => {
    const db = createMockDb()

    const input = buildInput({
      frontmatter: {
        id: 'abc123def456',
        created: FIXED_ISO,
        modified: FIXED_ISO,
        tags: []
      },
      parsedContent: 'Still has #typescript in old content'
    })

    syncNoteToCache(db, input, { isNew: true, tagsOverride: [] })

    expect(setNoteTags).toHaveBeenCalledWith(db, 'abc123def456', [])
  })

  it('falls back to extracted tags when tagsOverride is not provided', () => {
    const db = createMockDb()

    const input = buildInput({
      parsedContent: 'Has #typescript inline'
    })

    syncNoteToCache(db, input, { isNew: true })

    expect(setNoteTags).toHaveBeenCalledWith(db, 'abc123def456', ['typescript'])
  })

  it('mirrors canonical note metadata into data.db', () => {
    const db = createMockDb()

    const input = buildInput({
      path: 'journal/2026-01-15.md',
      parsedContent: 'Daily note'
    })

    syncNoteToCache(db, input, { isNew: true })

    expect(saveCanonicalNote).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: 'abc123def456',
        path: 'journal/2026-01-15.md',
        title: '2026-01-15',
        journalDate: null,
        localOnly: false,
        emoji: null,
        properties: {},
        createdAt: FIXED_ISO,
        modifiedAt: FIXED_ISO
      })
    )
  })
})
