import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PortalChannels } from '@memry/contracts/ipc-channels'
import { createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { getPortalRefsForHost } from '@main/database/queries/notes'

const getIndexDatabase = vi.hoisted(() => vi.fn())
const broadcastToAllWindows = vi.hoisted(() => vi.fn())

vi.mock('../../database', () => ({ getIndexDatabase }))
vi.mock('../../lib/window-broadcast', () => ({ broadcastToAllWindows }))

import { createPortalRefsProjector } from './portal-refs-projector'

const fence = (body: string): string => '```memry-portal\n' + body + '\n```'

const upsert = (noteId: string, parsedContent: string | null) => ({
  type: 'note.upserted' as const,
  note: { kind: 'markdown' as const, noteId, parsedContent } as never
})

describe('portal-refs projector', () => {
  let indexDb: TestDatabaseResult

  beforeEach(() => {
    indexDb = createTestIndexDb()
    getIndexDatabase.mockReturnValue(indexDb.db)
  })

  afterEach(() => {
    indexDb.close()
    vi.clearAllMocks()
  })

  it('writes a row per portal fence and announces the sources', async () => {
    const projector = createPortalRefsProjector()
    await projector.project(
      upsert(
        'host',
        fence('{"v":1,"note":"src","blocks":["abc123"]}') +
          '\n\n' +
          fence('{"search":{"tag":"bio","limit":5}}')
      )
    )

    expect(getPortalRefsForHost(indexDb.db, 'host')).toEqual([
      {
        hostNoteId: 'host',
        ordinal: 0,
        root: 0,
        sourceNoteId: 'src',
        anchor: 'abc123',
        kind: 'blocks'
      },
      {
        hostNoteId: 'host',
        ordinal: 1,
        root: 0,
        sourceNoteId: null,
        anchor: null,
        kind: 'search'
      }
    ])
    expect(broadcastToAllWindows).toHaveBeenCalledWith(PortalChannels.events.USAGE_CHANGED, {
      noteIds: ['src']
    })
  })

  it('announces both the old and new source when a portal is retargeted, and nothing when unchanged', async () => {
    const projector = createPortalRefsProjector()
    await projector.project(upsert('host', fence('{"note":"a"}')))
    broadcastToAllWindows.mockClear()

    await projector.project(upsert('host', fence('{"note":"a"}')))
    expect(broadcastToAllWindows).not.toHaveBeenCalled()

    await projector.project(upsert('host', fence('{"note":"b"}')))
    const [, payload] = broadcastToAllWindows.mock.calls[0]
    expect([...(payload as { noteIds: string[] }).noteIds].toSorted()).toEqual(['a', 'b'])
    expect(getPortalRefsForHost(indexDb.db, 'host').map((row) => row.sourceNoteId)).toEqual(['b'])
  })

  it('clears a host that lost its portals and one that was deleted', async () => {
    const projector = createPortalRefsProjector()
    await projector.project(upsert('host', fence('{"note":"a"}')))
    await projector.project(upsert('host', 'no portals left'))
    expect(getPortalRefsForHost(indexDb.db, 'host')).toEqual([])

    await projector.project(upsert('host2', fence('{"note":"a"}')))
    broadcastToAllWindows.mockClear()
    await projector.project({ type: 'note.deleted', noteId: 'host2' })
    expect(getPortalRefsForHost(indexDb.db, 'host2')).toEqual([])
    expect(broadcastToAllWindows).toHaveBeenCalledWith(PortalChannels.events.USAGE_CHANGED, {
      noteIds: ['a']
    })
  })

  it('keeps rows when the body was not read', async () => {
    const projector = createPortalRefsProjector()
    await projector.project(upsert('host', fence('{"note":"a"}')))
    await projector.project(upsert('host', null))
    expect(getPortalRefsForHost(indexDb.db, 'host')).toHaveLength(1)
  })

  it('does not drop rows of a deleted source', async () => {
    const projector = createPortalRefsProjector()
    await projector.project(upsert('host', fence('{"note":"gone"}')))
    await projector.project({ type: 'note.deleted', noteId: 'gone' })
    expect(getPortalRefsForHost(indexDb.db, 'host')).toHaveLength(1)
  })
})
