import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PortalChannels } from '@memry/contracts/ipc-channels'
import { createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { getBlockLinkRefsForSource } from '@main/database/queries/notes'

const getIndexDatabase = vi.hoisted(() => vi.fn())
const broadcastToAllWindows = vi.hoisted(() => vi.fn())

vi.mock('../../database', () => ({ getIndexDatabase }))
vi.mock('../../lib/window-broadcast', () => ({ broadcastToAllWindows }))

import { createBlockLinkRefsProjector } from './block-link-refs-projector'

const upsert = (noteId: string, parsedContent: string | null) => ({
  type: 'note.upserted' as const,
  note: { kind: 'markdown' as const, noteId, parsedContent } as never
})

describe('block-link-refs projector', () => {
  let indexDb: TestDatabaseResult

  beforeEach(() => {
    indexDb = createTestIndexDb()
    getIndexDatabase.mockReturnValue(indexDb.db)
  })
  afterEach(() => {
    indexDb.close()
    vi.clearAllMocks()
  })

  it('stores a note block links and announces when they change', async () => {
    const projector = createBlockLinkRefsProjector()
    await projector.project(upsert('host', 'See [[Cell Biology#^chl-7f2a]].'))
    expect(getBlockLinkRefsForSource(indexDb.db, 'host')).toEqual([
      { sourceNoteId: 'host', targetKey: 'cell biology', anchor: 'chl-7f2a' }
    ])
    expect(broadcastToAllWindows).toHaveBeenCalledWith(PortalChannels.events.USAGE_CHANGED, {
      noteIds: ['*']
    })

    broadcastToAllWindows.mockClear()
    await projector.project(upsert('host', 'See [[Cell Biology#^chl-7f2a]] again.'))
    expect(broadcastToAllWindows).not.toHaveBeenCalled()

    await projector.project(upsert('host', 'No links now.'))
    expect(getBlockLinkRefsForSource(indexDb.db, 'host')).toEqual([])
    expect(broadcastToAllWindows).toHaveBeenCalledTimes(1)
  })

  it('keeps rows when the body was not read, and drops them with the note', async () => {
    const projector = createBlockLinkRefsProjector()
    await projector.project(upsert('host', '[[Cell Biology#^chl-7f2a]]'))
    await projector.project(upsert('host', null))
    expect(getBlockLinkRefsForSource(indexDb.db, 'host')).toHaveLength(1)
    await projector.project({ type: 'note.deleted', noteId: 'host' })
    expect(getBlockLinkRefsForSource(indexDb.db, 'host')).toEqual([])
  })
})
