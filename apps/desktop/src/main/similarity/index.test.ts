import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as sqliteVec from 'sqlite-vec'
import { noteCache, noteLinks, noteTags } from '@memry/db-schema/schema/notes-cache'
import { settings } from '@memry/db-schema/schema/settings'
import {
  cleanupTestDatabase,
  createTestDatabase,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'

vi.mock('../database', () => ({
  getDatabase: vi.fn(),
  getIndexDatabase: vi.fn(),
  getRawIndexDatabase: vi.fn()
}))

import { getDatabase, getIndexDatabase, getRawIndexDatabase } from '../database'
import { clusterNotes, getSimilarNotes, getTagSuggestions } from './index'

const NOW = '2026-05-09T00:00:00.000Z'

describe('similarity', () => {
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult

  const addNote = (id: string, path: string, vector: number[] | null, tags: string[] = []) => {
    indexDb.db
      .insert(noteCache)
      .values({ id, path, title: id, createdAt: NOW, modifiedAt: NOW })
      .run()
    for (const tag of tags) indexDb.db.insert(noteTags).values({ noteId: id, tag }).run()
    if (vector) {
      indexDb.sqlite
        .prepare('INSERT INTO vec_notes (note_id, embedding) VALUES (?, ?)')
        .run(id, Float32Array.from(vector))
    }
  }

  beforeEach(() => {
    dataDb = createTestDatabase()
    indexDb = createTestIndexDb()
    sqliteVec.load(indexDb.sqlite)
    indexDb.sqlite.exec(
      'CREATE VIRTUAL TABLE vec_notes USING vec0(note_id TEXT PRIMARY KEY, embedding float[3] distance_metric=cosine)'
    )
    // The shared test helper types every DB with the combined schema.
    vi.mocked(getDatabase).mockReturnValue(dataDb.db as never)
    vi.mocked(getIndexDatabase).mockReturnValue(indexDb.db)
    vi.mocked(getRawIndexDatabase).mockReturnValue(indexDb.sqlite)
  })

  afterEach(() => {
    cleanupTestDatabase(dataDb)
    cleanupTestDatabase(indexDb)
    vi.clearAllMocks()
  })

  describe('getSimilarNotes', () => {
    it('returns nearest notes, closest first, without the note itself', () => {
      addNote('source', 'sleep/source.md', [1, 0, 0])
      addNote('close', 'sleep/close.md', [0.95, 0.1, 0])
      addNote('closer', 'sleep/closer.md', [0.99, 0.05, 0])
      addNote('unrelated', 'code/unrelated.md', [0, 0, 1])

      const result = getSimilarNotes('source', 5)

      expect(result.status).toBe('ready')
      expect(result.notes.map((note) => note.id)).toEqual(['closer', 'close'])
      expect(result.notes[0]).toMatchObject({ title: 'closer', path: 'sleep/closer.md' })
    })

    it('excludes notes already linked either way', () => {
      addNote('source', 'a/source.md', [1, 0, 0])
      addNote('outgoing', 'a/outgoing.md', [0.99, 0.01, 0])
      addNote('incoming', 'a/incoming.md', [0.98, 0.02, 0])
      addNote('free', 'a/free.md', [0.97, 0.03, 0])
      indexDb.db
        .insert(noteLinks)
        .values([
          { sourceId: 'source', targetId: 'outgoing', targetTitle: 'outgoing' },
          { sourceId: 'incoming', targetId: 'source', targetTitle: 'source' }
        ])
        .run()

      expect(getSimilarNotes('source', 5).notes.map((note) => note.id)).toEqual(['free'])
    })

    it('reports why it is empty', () => {
      addNote('unembedded', 'a/unembedded.md', null)
      expect(getSimilarNotes('unembedded').status).toBe('no-embedding')

      dataDb.db.insert(settings).values({ key: 'ai.enabled', value: 'false' }).run()
      expect(getSimilarNotes('unembedded')).toEqual({ status: 'disabled', notes: [] })
    })
  })

  describe('getTagSuggestions', () => {
    it('suggests tags shared by several neighbours, not ones the note has', () => {
      addNote('source', 'a/source.md', [1, 0, 0], ['mine'])
      addNote('n1', 'a/n1.md', [0.95, 0.1, 0], ['sleep', 'mine'])
      addNote('n2', 'a/n2.md', [0.9, 0.2, 0], ['sleep'])
      addNote('n3', 'a/n3.md', [0.9, 0.1, 0.1], ['once'])

      const result = getTagSuggestions('source')

      expect(result.status).toBe('ready')
      expect(result.tags.map((tag) => tag.tag)).toEqual(['sleep'])
      expect(result.tags[0].support).toBe(2)
    })
  })

  describe('clusterNotes', () => {
    it('groups by similarity, names from shared tags, and reports missing vectors', () => {
      addNote('s1', 'health/s1.md', [1, 0.1, 0], ['sleep'])
      addNote('s2', 'health/s2.md', [0.9, 0.2, 0], ['sleep'])
      addNote('c1', 'code/c1.md', [0, 1, 0.1])
      addNote('c2', 'code/c2.md', [0.1, 1, 0])
      addNote('lonely', 'x/lonely.md', [0, 0, 1])
      addNote('empty', 'x/empty.md', null)

      const result = clusterNotes(['s1', 'c1', 's2', 'c2', 'lonely', 'empty'])

      expect(result.status).toBe('ready')
      expect(result.groups).toEqual([
        { noteIds: ['s1', 's2'], titles: ['s1', 's2'], suggestedName: 'sleep' },
        { noteIds: ['c1', 'c2'], titles: ['c1', 'c2'], suggestedName: 'code' }
      ])
      expect(result.ungrouped).toEqual(['lonely'])
      expect(result.missing).toEqual(['empty'])
    })
  })
})
