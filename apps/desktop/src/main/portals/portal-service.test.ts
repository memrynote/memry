import * as Y from 'yjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { insertNoteCache, setNoteTags, setPortalRefs } from '@main/database/queries/notes'

const getIndexDatabase = vi.hoisted(() => vi.fn())
const docs = vi.hoisted(() => new Map<string, unknown>())
const live = vi.hoisted(() => new Set<string>())
const locked = vi.hoisted(() => new Set<string>())
const searchAll = vi.hoisted(() => vi.fn())
const writebackNow = vi.hoisted(() => vi.fn(async () => {}))
const scheduleWriteback = vi.hoisted(() => vi.fn())
const released = vi.hoisted(() => vi.fn())

vi.mock('../database', () => ({ getIndexDatabase, getDatabase: () => ({}) }))
vi.mock('../search/store', () => ({ searchQueries: { searchAll } }))
vi.mock('../sync/crdt-writeback', () => ({ writebackNow, scheduleWriteback }))
vi.mock('../vault-locks/registry', () => ({ isNoteLocked: (id: string) => locked.has(id) }))
vi.mock('../sync/crdt-provider', () => ({
  ORIGIN_LOCAL: 'local',
  getCrdtProvider: () => ({
    getDoc: (id: string) => (live.has(id) ? docs.get(id) : undefined),
    holdDoc: () => released,
    open: async (id: string) => docs.get(id)
  })
}))

import { getPortalUsage, searchPortalBlocks, stampAnchor } from './portal-service'

function paragraphDoc(blocks: { id: string; text: string }[]): Y.Doc {
  const doc = new Y.Doc()
  const root = new Y.XmlElement('blockGroup')
  doc.getXmlFragment(CRDT_FRAGMENT_NAME).insert(0, [root])
  root.insert(
    0,
    blocks.map((block) => {
      const container = new Y.XmlElement('blockContainer')
      container.setAttribute('id', block.id)
      const paragraph = new Y.XmlElement('paragraph')
      container.insert(0, [paragraph])
      const text = new Y.XmlText()
      paragraph.insert(0, [text])
      text.insert(0, block.text)
      return container
    })
  )
  return doc
}

describe('portal service', () => {
  let indexDb: TestDatabaseResult

  const addNote = (id: string, title = id): void => {
    insertNoteCache(indexDb.db, {
      id,
      path: `notes/${id}.md`,
      title,
      contentHash: `hash-${id}`,
      wordCount: 0,
      characterCount: 0,
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z'
    })
  }

  beforeEach(() => {
    indexDb = createTestIndexDb()
    getIndexDatabase.mockReturnValue(indexDb.db)
  })

  afterEach(() => {
    indexDb.close()
    docs.clear()
    live.clear()
    locked.clear()
    vi.clearAllMocks()
  })

  describe('getPortalUsage', () => {
    it('lists hosts with counts, filters by anchor, and survives a deleted source', () => {
      addNote('hostA', 'Alpha')
      addNote('hostB', 'Beta')
      setPortalRefs(indexDb.db, 'hostA', [
        {
          hostNoteId: 'hostA',
          ordinal: 0,
          sourceNoteId: 'src',
          anchor: null,
          hiddenCount: 0,
          kind: 'note'
        },
        {
          hostNoteId: 'hostA',
          ordinal: 1,
          sourceNoteId: 'src',
          anchor: 'abc123',
          hiddenCount: 2,
          kind: 'block'
        },
        {
          hostNoteId: 'hostA',
          ordinal: 2,
          sourceNoteId: null,
          anchor: null,
          hiddenCount: 0,
          kind: 'search'
        }
      ])
      setPortalRefs(indexDb.db, 'hostB', [
        {
          hostNoteId: 'hostB',
          ordinal: 0,
          sourceNoteId: 'src',
          anchor: 'abc123',
          hiddenCount: 1,
          kind: 'block'
        }
      ])

      // `src` has no note row at all, as after a delete.
      expect(getPortalUsage({ noteId: 'src' }).hosts).toEqual([
        { noteId: 'hostA', title: 'Alpha', path: 'notes/hostA.md', count: 2, hiddenCount: 2 },
        { noteId: 'hostB', title: 'Beta', path: 'notes/hostB.md', count: 1, hiddenCount: 1 }
      ])
      expect(getPortalUsage({ noteId: 'src', anchor: 'abc123' }).hosts.map((h) => h.count)).toEqual(
        [1, 1]
      )
      expect(getPortalUsage({ noteId: 'src', anchor: 'zzzz' }).hosts).toEqual([])
    })
  })

  describe('stampAnchor', () => {
    it('stamps through a doc it opened and writes it back before closing', async () => {
      addNote('src')
      docs.set('src', paragraphDoc([{ id: 'b1', text: 'Mitochondria' }]))

      const result = await stampAnchor('src', 'b1')

      expect(result.success).toBe(true)
      const anchor = result.success ? result.anchor : ''
      expect(anchor).toMatch(/^[a-z0-9]{6}$/)
      expect((docs.get('src') as Y.Doc).getXmlFragment(CRDT_FRAGMENT_NAME).toString()).toContain(
        `Mitochondria ^${anchor}`
      )
      expect(writebackNow).toHaveBeenCalledTimes(1)
      expect(released).toHaveBeenCalledTimes(1)
      expect(await stampAnchor('src', 'b1')).toEqual({ success: true, anchor })
      expect(writebackNow).toHaveBeenCalledTimes(1)
    })

    it('schedules the debounced writeback for a doc a window holds', async () => {
      addNote('src')
      docs.set('src', paragraphDoc([{ id: 'b1', text: 'Open in editor' }]))
      live.add('src')

      await stampAnchor('src', 'b1')

      expect(scheduleWriteback).toHaveBeenCalledTimes(1)
      expect(writebackNow).not.toHaveBeenCalled()
    })

    it('refuses a missing note, a missing block and a locked note without editing', async () => {
      addNote('src')
      addNote('vault')
      docs.set('src', paragraphDoc([{ id: 'b1', text: 'x' }]))
      docs.set('vault', paragraphDoc([{ id: 'b1', text: 'secret' }]))
      locked.add('vault')

      expect(await stampAnchor('nope', 'b1')).toEqual({ success: false, reason: 'missing-note' })
      expect(await stampAnchor('src', 'nope')).toEqual({ success: false, reason: 'missing-block' })
      expect(await stampAnchor('vault', 'b1')).toEqual({ success: false, reason: 'locked' })
      expect(
        (docs.get('vault') as Y.Doc).getXmlFragment(CRDT_FRAGMENT_NAME).toString()
      ).not.toContain('^')
      expect(writebackNow).not.toHaveBeenCalled()
    })
  })

  describe('searchPortalBlocks', () => {
    const hit = (id: string) => ({ groups: [{ type: 'note', results: [{ id }] }] })

    beforeEach(() => {
      addNote('n1', 'Biology')
      addNote('n2', 'Chemistry')
      docs.set(
        'n1',
        paragraphDoc([
          { id: 'a', text: 'Exam on Friday ^exam01' },
          { id: 'b', text: 'Unrelated' },
          { id: 'c', text: 'Study for the EXAM' }
        ])
      )
      docs.set('n2', paragraphDoc([{ id: 'd', text: 'Lab report' }]))
    })

    it('finds blocks containing every term, case-insensitively, with their anchors', async () => {
      searchAll.mockReturnValue({
        groups: [{ type: 'note', results: [{ id: 'n1' }, { id: 'n2' }] }]
      })

      const { results, truncated } = await searchPortalBlocks({ text: 'exam', limit: 10 })

      expect(truncated).toBe(false)
      expect(results).toEqual([
        {
          noteId: 'n1',
          title: 'Biology',
          path: 'notes/n1.md',
          blockId: 'a',
          anchor: 'exam01',
          text: 'Exam on Friday'
        },
        {
          noteId: 'n1',
          title: 'Biology',
          path: 'notes/n1.md',
          blockId: 'c',
          anchor: null,
          text: 'Study for the EXAM'
        }
      ])
      expect(searchAll.mock.calls[0][2]).toMatchObject({ text: 'exam', types: ['note'], tags: [] })
      const both = await searchPortalBlocks({ text: 'study exam', limit: 10 })
      expect(both.results.map((r) => r.blockId)).toEqual(['c'])
    })

    it('flags truncation when more blocks match than the limit', async () => {
      searchAll.mockReturnValue(hit('n1'))
      const { results, truncated } = await searchPortalBlocks({ text: 'exam', limit: 1 })
      expect(results.map((r) => r.blockId)).toEqual(['a'])
      expect(truncated).toBe(true)
    })

    it('lists the first non-empty blocks of notes carrying a tag when no text is given', async () => {
      setNoteTags(indexDb.db, 'n2', { header: ['bio'], inline: [] })

      const { results } = await searchPortalBlocks({ tag: 'bio', limit: 10 })

      expect(searchAll).not.toHaveBeenCalled()
      expect(results.map((r) => r.blockId)).toEqual(['d'])
    })

    it('skips locked notes', async () => {
      locked.add('n1')
      searchAll.mockReturnValue(hit('n1'))
      expect((await searchPortalBlocks({ text: 'exam', limit: 10 })).results).toEqual([])
    })
  })
})
