import { describe, it, expect, vi } from 'vitest'
import { SyncEngine } from '../engine'
import { createLogger } from '../../lib/logger'
import { EVENT_CHANNELS } from '@memry/contracts/ipc-events'
import { createMockDeps, setupTestDb } from '@tests/utils/engine-mocks'

vi.mock('../../lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { createLogger: () => logger }
})

describe('PullCoordinator', () => {
  const { getDb } = setupTestDb()

  describe('#given a pull page whose server response fails schema validation #when the page is processed', () => {
    it('#then logs pull_page_dropped with the dropped item count instead of failing silently', async () => {
      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)
      const logger = createLogger('test') as unknown as { warn: ReturnType<typeof vi.fn> }

      vi.spyOn(await import('../http-client'), 'getFromServer').mockResolvedValue({
        items: [{ id: 'task-1', type: 'task', version: 1, modifiedAt: 1000, size: 10 }],
        deleted: ['task-2'],
        hasMore: false,
        nextCursor: 1
      })

      // Malformed: `type` isn't a recognized record sync item type, so
      // RecordPullResponseSchema.safeParse fails for the whole page.
      vi.spyOn(await import('../http-client'), 'postToServer').mockResolvedValue({
        items: [{ id: 'task-1', type: 'not_a_real_type' }]
      })

      await engine.pull()

      expect(logger.warn).toHaveBeenCalledWith('pull_page_dropped', {
        reason: 'invalid_pull_response',
        droppedCount: 2
      })

      vi.restoreAllMocks()
    })
  })

  describe('#given a one-page pull #when INITIAL_SYNC_PROGRESS could be emitted', () => {
    // The emission is gated on ctx.fullSyncActive so socket reconnects and
    // periodic ticks never masquerade as initial-sync progress. Nothing pinned
    // the gate: removing it broke zero tests, and a stray event would resurrect
    // the renderer's skeleton long after the first sync finished.
    it('#then progress streams only while a full sync is active', async () => {
      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)
      vi.spyOn(await import('../http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 1
      })
      const progressEvent = (channel: string, data: unknown): boolean =>
        channel === EVENT_CHANNELS.INITIAL_SYNC_PROGRESS &&
        (data as { phase?: string }).phase === 'notes'

      // Gate OFF — a plain pull (periodic tick, reconnect, broadcast) must
      // stay silent.
      await engine.pull()
      const progressCalls = (deps.emitToRenderer as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => progressEvent(call[0], call[1])
      )
      expect(progressCalls).toHaveLength(0)

      // Gate ON — the same page inside an active fullSync streams progress.
      engine['ctx'].fullSyncActive = true
      try {
        await engine.pull()
        expect(deps.emitToRenderer).toHaveBeenCalledWith(EVENT_CHANNELS.INITIAL_SYNC_PROGRESS, {
          phase: 'notes',
          processedItems: 0,
          totalItems: 0
        })
      } finally {
        engine['ctx'].fullSyncActive = false
      }

      vi.restoreAllMocks()
    })
  })
})
