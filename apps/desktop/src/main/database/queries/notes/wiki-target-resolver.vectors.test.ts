/** `wiki-target-resolution.json` (chapter 12 §12.3) through the real index: names table, resolver, SQL. */
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { WikiMatchKind, WikiNameCandidate } from '@memry/shared/note-names'
import { createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { insertNoteCache } from './note-crud'
import { reindexNoteNames } from './note-names-queries'
import { resolveLinkTargets } from './wiki-target-resolver'

interface Vectors {
  notes: WikiNameCandidate[]
  resolution: Array<{
    name: string
    query: string
    expected: { noteId: string; matchedBy: WikiMatchKind } | null
  }>
}

const vectors = JSON.parse(
  readFileSync(
    new URL(
      '../../../../../../../packages/contracts/test-vectors/wiki-target-resolution.json',
      import.meta.url
    ),
    'utf8'
  )
) as Vectors

describe('wiki-target-resolution vectors against the index', () => {
  let index: TestDatabaseResult

  beforeAll(() => {
    index = createTestIndexDb()
    for (const note of vectors.notes) {
      insertNoteCache(index.db, {
        id: note.noteId,
        path: note.path,
        title: note.title,
        date: note.journal ? note.title : null,
        createdAt: '2026-01-01T00:00:00.000Z',
        modifiedAt: '2026-01-01T00:00:00.000Z'
      })
      reindexNoteNames(index.db, {
        noteId: note.noteId,
        title: note.title,
        aliases: { kind: 'read', aliases: note.aliases }
      })
    }
  })

  afterAll(() => index.close())

  it.each(vectors.resolution.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const match = resolveLinkTargets(index.db, [c.query]).get(c.query)
    expect(match ? { noteId: match.noteId, matchedBy: match.matchedBy } : null).toEqual(c.expected)
  })

  it('resolves every case in one batch exactly as one by one', () => {
    const batch = resolveLinkTargets(
      index.db,
      vectors.resolution.map((c) => c.query)
    )
    expect(vectors.resolution.map((c) => batch.get(c.query)?.noteId ?? null)).toEqual(
      vectors.resolution.map((c) => c.expected?.noteId ?? null)
    )
  })
})
