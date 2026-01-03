import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TestDatabaseResult, TestDb } from '@tests/utils/test-db'
import { createTestIndexDb } from '@tests/utils/test-db'
import { insertNoteCache, setNoteTags } from './notes'
import {
  searchNotes,
  quickSearch,
  getSuggestions,
  findNotesByTag,
  findBacklinks,
  getSearchableCount,
  isFtsHealthy,
  highlightTerms,
  extractSnippet,
  escapeSearchQuery,
  buildPrefixQuery
} from './search'
import { createFtsTable, insertFtsNote } from '../../../main/database/fts'

describe('search queries', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb

  const insertNote = (id: string, title: string, content: string, tags: string[], path: string) => {
    insertNoteCache(db, {
      id,
      path,
      title,
      contentHash: `hash-${id}`,
      wordCount: content.split(/\s+/).length,
      characterCount: content.length,
      date: null,
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z'
    })
    setNoteTags(db, id, tags)
    insertFtsNote(db, id, title, content, tags)
  }

  beforeEach(() => {
    dbResult = createTestIndexDb()
    db = dbResult.db
    createFtsTable(db)

    insertNote('note-1', 'Alpha Note', 'hello world', ['alpha'], 'notes/alpha.md')
    insertNote('note-2', 'Beta Note', 'hello memry', ['beta'], 'notes/beta.md')
    insertNote('note-3', 'Project Alpha', 'alpha beta', ['alpha', 'beta'], 'projects/alpha.md')

    db.run(
      "INSERT INTO note_links (source_id, target_id, target_title) VALUES ('note-1', 'note-2', 'Beta Note')"
    )
  })

  afterEach(() => {
    dbResult.close()
  })

  it('searches notes using FTS with prefix matching', () => {
    const results = searchNotes(db, 'hello')
    expect(results.map((r) => r.id).sort()).toEqual(['note-1', 'note-2'])

    const prefixResults = searchNotes(db, 'proj')
    expect(prefixResults.map((r) => r.id)).toContain('note-3')
  })

  it('orders search results by BM25 score', () => {
    const results = searchNotes(db, 'alpha')
    const scores = results.map((r) => r.score)
    expect(scores).toEqual([...scores].sort((a, b) => a - b))
  })

  it('matches multiple terms across content', () => {
    const results = searchNotes(db, 'alpha beta')
    expect(results.map((r) => r.id)).toContain('note-3')
  })

  it('handles phrase queries by treating them as multi-term searches', () => {
    // FTS5 phrase syntax uses quotes like "hello world" to match exact phrases
    // Our implementation intentionally strips quotes for simplicity, converting
    // phrase queries into multi-term AND queries
    const phraseResults = searchNotes(db, '"hello world"')
    expect(phraseResults.map((r) => r.id)).toContain('note-1')

    // Verify escapeSearchQuery strips quotes
    expect(escapeSearchQuery('"hello world"')).toBe('hello world')

    // A phrase query should behave like a multi-term query
    const multiTermResults = searchNotes(db, 'hello world')
    expect(multiTermResults.map((r) => r.id)).toEqual(phraseResults.map((r) => r.id))
  })

  it('returns quick search results', () => {
    const results = quickSearch(db, 'alpha')
    expect(results.notes.length).toBeGreaterThan(0)
  })

  it('returns search suggestions for tags and titles', () => {
    const suggestions = getSuggestions(db, 'al', 5)
    expect(suggestions.some((s) => s.text === 'alpha')).toBe(true)
  })

  it('finds notes by tag and backlinks', () => {
    const tagged = findNotesByTag(db, 'beta')
    expect(tagged.map((r) => r.id)).toEqual(expect.arrayContaining(['note-2', 'note-3']))

    const backlinks = findBacklinks(db, 'note-2')
    expect(backlinks.map((r) => r.id)).toEqual(['note-1'])
  })

  it('tracks FTS counts and health', () => {
    expect(getSearchableCount(db)).toBe(3)
    expect(isFtsHealthy(db)).toBe(true)

    insertNoteCache(db, {
      id: 'note-4',
      path: 'notes/missing.md',
      title: 'Missing',
      contentHash: 'hash-4',
      wordCount: 1,
      characterCount: 10,
      date: null,
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z'
    })
    expect(isFtsHealthy(db)).toBe(false)
  })

  it('escapes queries and highlights snippets', () => {
    expect(escapeSearchQuery('"hello" (world)')).toBe('hello world')
    expect(buildPrefixQuery('hello world')).toBe('"hello"* "world"*')
    expect(highlightTerms('Hello world', 'world')).toBe('Hello <mark>world</mark>')
    expect(extractSnippet('Hello world', 'world', 3)).toContain('<mark>world</mark>')
  })
})
