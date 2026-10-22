import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDataDb, createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { getGraphData, getLocalGraph } from '../graph'
import { insertNoteCache, deleteNoteCache } from './note-crud'
import { getIncomingReferences } from './link-queries'
import { setPortalRefs } from './portal-ref-queries'

describe('portal references', () => {
  let dbResult: TestDatabaseResult

  const addNote = (id: string): void => {
    insertNoteCache(dbResult.db, {
      id,
      path: `notes/${id}.md`,
      title: id,
      contentHash: `hash-${id}`,
      wordCount: 0,
      characterCount: 0,
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z'
    })
  }

  const portal = (host: string, ordinal: number, source: string | null) => ({
    hostNoteId: host,
    ordinal,
    sourceNoteId: source,
    root: 0,
    anchor: null,
    kind: source ? ('note' as const) : ('search' as const)
  })

  beforeEach(() => {
    dbResult = createTestIndexDb()
    addNote('host')
    addNote('src')
    setPortalRefs(dbResult.db, 'host', [
      portal('host', 0, 'src'),
      portal('host', 1, 'src'),
      portal('host', 2, null)
    ])
  })

  afterEach(() => dbResult.close())

  it('lists each host once as an incoming portal reference', () => {
    expect(getIncomingReferences(dbResult.db, 'src')).toEqual([
      { sourceNoteId: 'host', via: { kind: 'portal' } }
    ])
    expect(getIncomingReferences(dbResult.db, 'host')).toEqual([])
  })

  it('drops a host that no longer exists', () => {
    deleteNoteCache(dbResult.db, 'host')
    expect(getIncomingReferences(dbResult.db, 'src')).toEqual([])
  })

  it('draws one portal edge from host to source in both graph builds', () => {
    const edge = { id: 'host-src-portal', source: 'host', target: 'src', type: 'portal', weight: 1 }
    const dataDb = createTestDataDb()
    try {
      const all = getGraphData(dbResult.db as never, dataDb.db as never)
      expect(all.edges.filter((e) => e.type === 'portal')).toEqual([edge])
      const local = getLocalGraph(dbResult.db as never, dataDb.db as never, 'src', 1)
      expect(local.edges).toEqual([edge])
      expect(local.nodes.map((n) => n.id).sort()).toEqual(['host', 'src'])
    } finally {
      dataDb.close()
    }
  })
})
