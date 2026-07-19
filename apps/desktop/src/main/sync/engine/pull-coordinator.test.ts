import { describe, it, expect, vi } from 'vitest'
import { SyncEngine } from '../engine'
import { createLogger } from '../../lib/logger'
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
})
