import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { DEFAULT_MAX_ATTEMPTS, SyncQueueManager, type EnqueueInput } from './queue'

const makeInput = (overrides: Partial<EnqueueInput> = {}): EnqueueInput => ({
  type: 'note',
  itemId: 'item-1',
  operation: 'create',
  payload: JSON.stringify({ title: 'Test' }),
  ...overrides
})

function simulateFailedAttempt(q: SyncQueueManager, id: string, error: string): void {
  q.dequeue(1)
  q.markFailed(id, error)
}

describe('SyncQueueManager', () => {
  let testDb: TestDatabaseResult
  let queue: SyncQueueManager

  beforeEach(() => {
    testDb = createTestDataDb()
    queue = new SyncQueueManager(testDb.db)
  })

  afterEach(() => {
    testDb.close()
  })

  describe('enqueue', () => {
    it('returns id and item is persisted', () => {
      // #given empty queue
      // #when enqueue
      const id = queue.enqueue(makeInput())

      // #then
      expect(id).toBeTruthy()
      expect(queue.getSize()).toBe(1)
    })

    it('deduplicates same itemId+type with zero attempts', () => {
      // #given existing item
      const id1 = queue.enqueue(makeInput({ payload: '{"v":1}' }))

      // #when enqueue same itemId+type
      const id2 = queue.enqueue(makeInput({ payload: '{"v":2}' }))

      // #then updates payload, same id
      expect(id2).toBe(id1)
      expect(queue.getSize()).toBe(1)
      const items = queue.peek(1)
      expect(items[0].payload).toBe('{"v":2}')
    })

    it('coalesces create+update into create', () => {
      // #given pending create
      const id = queue.enqueue(makeInput({ operation: 'create', payload: '{"v":1}' }))

      // #when update arrives for same item
      queue.enqueue(makeInput({ operation: 'update', payload: '{"v":2}' }))

      // #then single entry, operation stays create, payload updated
      expect(queue.getSize()).toBe(1)
      const items = queue.peek(1)
      expect(items[0].id).toBe(id)
      expect(items[0].operation).toBe('create')
      expect(items[0].payload).toBe('{"v":2}')
    })

    it('coalesces update+create into create', () => {
      // #given pending update
      queue.enqueue(makeInput({ operation: 'update', payload: '{"v":1}' }))

      // #when create arrives for same item
      queue.enqueue(makeInput({ operation: 'create', payload: '{"v":2}' }))

      // #then promotes to create
      expect(queue.getSize()).toBe(1)
      const items = queue.peek(1)
      expect(items[0].operation).toBe('create')
      expect(items[0].payload).toBe('{"v":2}')
    })

    it('coalesces create+delete into delete', () => {
      // #given pending create
      queue.enqueue(makeInput({ operation: 'create', payload: '{"v":1}' }))

      // #when delete arrives
      queue.enqueue(makeInput({ operation: 'delete', payload: '{"deleted":true}' }))

      // #then delete wins
      expect(queue.getSize()).toBe(1)
      const items = queue.peek(1)
      expect(items[0].operation).toBe('delete')
      expect(items[0].payload).toBe('{"deleted":true}')
    })

    it('coalesces update+update keeping update operation', () => {
      // #given pending update
      queue.enqueue(makeInput({ operation: 'update', payload: '{"v":1}' }))

      // #when another update arrives
      queue.enqueue(makeInput({ operation: 'update', payload: '{"v":2}' }))

      // #then stays update with latest payload
      expect(queue.getSize()).toBe(1)
      const items = queue.peek(1)
      expect(items[0].operation).toBe('update')
      expect(items[0].payload).toBe('{"v":2}')
    })

    it('creates new entry when existing item has attempts > 0', () => {
      // #given existing item with attempts > 0 (dequeue increments)
      const id1 = queue.enqueue(makeInput())
      simulateFailedAttempt(queue, id1, 'network error')

      // #when enqueue same itemId+type+operation
      const id2 = queue.enqueue(makeInput())

      // #then creates new entry
      expect(id2).not.toBe(id1)
      expect(queue.getSize()).toBe(2)
    })

    it('assigns default priority of 0', () => {
      // #given no priority specified
      queue.enqueue(makeInput())

      // #then
      const items = queue.peek(1)
      expect(items[0].priority).toBe(0)
    })

    it('respects custom priority', () => {
      // #given priority specified
      queue.enqueue(makeInput({ priority: 10 }))

      // #then
      const items = queue.peek(1)
      expect(items[0].priority).toBe(10)
    })
  })

  describe('dequeue', () => {
    it('returns highest priority first', () => {
      // #given items with different priorities
      queue.enqueue(makeInput({ itemId: 'low', priority: 1 }))
      queue.enqueue(makeInput({ itemId: 'high', priority: 10 }))
      queue.enqueue(makeInput({ itemId: 'mid', priority: 5 }))

      // #when dequeue
      const items = queue.dequeue(3)

      // #then
      expect(items[0].itemId).toBe('high')
      expect(items[1].itemId).toBe('mid')
      expect(items[2].itemId).toBe('low')
    })

    it('returns at most batchSize items', () => {
      // #given 5 items
      for (let i = 0; i < 5; i++) {
        queue.enqueue(makeInput({ itemId: `item-${i}` }))
      }

      // #when dequeue with batchSize 2
      const items = queue.dequeue(2)

      // #then
      expect(items).toHaveLength(2)
    })

    it('skips items that reached max attempts', () => {
      // #given item with max attempts (dead letter)
      const id = queue.enqueue(makeInput())
      for (let i = 0; i < DEFAULT_MAX_ATTEMPTS; i++) {
        simulateFailedAttempt(queue, id, `fail-${i}`)
      }

      // #when dequeue
      const items = queue.dequeue(10)

      // #then item is skipped
      expect(items).toHaveLength(0)
      expect(queue.getSize()).toBe(1)
    })

    it('increments attempts atomically on dequeue', () => {
      // #given item in queue
      queue.enqueue(makeInput())

      // #when dequeue
      queue.dequeue(1)

      // #then attempts incremented in DB
      const items = queue.peek(1)
      expect(items[0].attempts).toBe(1)
    })

    it('orders same-priority items by createdAt ascending', () => {
      // #given items created in sequence with same priority
      queue.enqueue(makeInput({ itemId: 'first' }))
      queue.enqueue(makeInput({ itemId: 'second' }))
      queue.enqueue(makeInput({ itemId: 'third' }))

      // #when dequeue
      const items = queue.dequeue(3)

      // #then FIFO within same priority
      expect(items[0].itemId).toBe('first')
      expect(items[1].itemId).toBe('second')
      expect(items[2].itemId).toBe('third')
    })
  })

  describe('peek', () => {
    it('returns items without modifying queue', () => {
      // #given
      queue.enqueue(makeInput())

      // #when peek twice
      const first = queue.peek(1)
      const second = queue.peek(1)

      // #then same result, queue unchanged
      expect(first).toEqual(second)
      expect(queue.getSize()).toBe(1)
    })

    it('includes dead-letter items', () => {
      // #given dead-letter item
      const id = queue.enqueue(makeInput())
      for (let i = 0; i < DEFAULT_MAX_ATTEMPTS; i++) {
        simulateFailedAttempt(queue, id, 'fail')
      }

      // #when peek
      const items = queue.peek()

      // #then includes dead-letter
      expect(items).toHaveLength(1)
      expect(items[0].attempts).toBe(DEFAULT_MAX_ATTEMPTS)
    })
  })

  describe('markSuccess', () => {
    it('removes item from queue', () => {
      // #given item in queue
      const id = queue.enqueue(makeInput())
      expect(queue.getSize()).toBe(1)

      // #when markSuccess
      queue.markSuccess(id)

      // #then
      expect(queue.getSize()).toBe(0)
    })
  })

  describe('markFailed', () => {
    it('records error after dequeue increments attempts', () => {
      // #given item dequeued (attempts incremented to 1)
      const id = queue.enqueue(makeInput())
      queue.dequeue(1)

      // #when markFailed
      queue.markFailed(id, 'connection timeout')

      // #then attempts=1 (from dequeue), error recorded
      const items = queue.peek(1)
      expect(items[0].attempts).toBe(1)
      expect(items[0].errorMessage).toBe('connection timeout')
      expect(items[0].lastAttempt).toBeInstanceOf(Date)
    })

    it('accumulates attempts via dequeue+markFailed cycles', () => {
      // #given item
      const id = queue.enqueue(makeInput())

      // #when fail 3 times (dequeue increments, markFailed records error)
      simulateFailedAttempt(queue, id, 'err-1')
      simulateFailedAttempt(queue, id, 'err-2')
      simulateFailedAttempt(queue, id, 'err-3')

      // #then
      const items = queue.peek(1)
      expect(items[0].attempts).toBe(3)
      expect(items[0].errorMessage).toBe('err-3')
    })
  })

  describe('getQueueStats', () => {
    it('returns correct counts for mixed queue', () => {
      // #given dead-letter and failed items dequeued first (via higher priority)
      const deadId = queue.enqueue(makeInput({ itemId: 'dead-1', priority: 10 }))
      for (let i = 0; i < DEFAULT_MAX_ATTEMPTS; i++) {
        simulateFailedAttempt(queue, deadId, `fail-${i}`)
      }

      const failedId = queue.enqueue(makeInput({ itemId: 'failed-1', priority: 5 }))
      simulateFailedAttempt(queue, failedId, 'err')

      // #given pending items (never dequeued)
      queue.enqueue(makeInput({ itemId: 'pending-1' }))
      queue.enqueue(makeInput({ itemId: 'pending-2' }))

      // #when
      const stats = queue.getQueueStats()

      // #then
      expect(stats.pending).toBe(2)
      expect(stats.failed).toBe(1)
      expect(stats.deadLetter).toBe(1)
      expect(stats.total).toBe(4)
    })

    it('returns zeroes for empty queue', () => {
      // #given empty queue
      const stats = queue.getQueueStats()

      // #then
      expect(stats).toEqual({ pending: 0, failed: 0, deadLetter: 0, total: 0 })
    })
  })

  describe('purgeOldErrors', () => {
    it('removes dead-letter items older than cutoff', () => {
      // #given dead-letter item
      const id = queue.enqueue(makeInput())
      for (let i = 0; i < DEFAULT_MAX_ATTEMPTS; i++) {
        simulateFailedAttempt(queue, id, 'fail')
      }

      // #when purge with future cutoff
      const cutoff = new Date(Date.now() + 60_000)
      const purged = queue.purgeOldErrors(cutoff)

      // #then
      expect(purged).toBe(1)
      expect(queue.getSize()).toBe(0)
    })

    it('does not purge items below max attempts', () => {
      // #given item with 1 attempt
      const id = queue.enqueue(makeInput())
      simulateFailedAttempt(queue, id, 'err')

      // #when purge
      const cutoff = new Date(Date.now() + 60_000)
      const purged = queue.purgeOldErrors(cutoff)

      // #then
      expect(purged).toBe(0)
      expect(queue.getSize()).toBe(1)
    })

    it('does not purge items newer than cutoff', () => {
      // #given dead-letter item
      const id = queue.enqueue(makeInput())
      for (let i = 0; i < DEFAULT_MAX_ATTEMPTS; i++) {
        simulateFailedAttempt(queue, id, 'fail')
      }

      // #when purge with past cutoff
      const cutoff = new Date(Date.now() - 60_000)
      const purged = queue.purgeOldErrors(cutoff)

      // #then
      expect(purged).toBe(0)
      expect(queue.getSize()).toBe(1)
    })
  })

  describe('clear', () => {
    it('empties entire queue', () => {
      // #given items in queue
      queue.enqueue(makeInput({ itemId: 'a' }))
      queue.enqueue(makeInput({ itemId: 'b' }))
      queue.enqueue(makeInput({ itemId: 'c' }))
      expect(queue.getSize()).toBe(3)

      // #when clear
      queue.clear()

      // #then
      expect(queue.getSize()).toBe(0)
    })
  })

  describe('removeById', () => {
    it('removes specific item', () => {
      // #given two items
      const id1 = queue.enqueue(makeInput({ itemId: 'keep' }))
      const id2 = queue.enqueue(makeInput({ itemId: 'remove' }))

      // #when removeById
      queue.removeById(id2)

      // #then
      expect(queue.getSize()).toBe(1)
      const items = queue.peek(1)
      expect(items[0].id).toBe(id1)
    })
  })

  describe('getRetryableItems', () => {
    it('returns items with attempts > 0 but below max', () => {
      // #given dead-letter item (highest priority, dequeued first)
      const deadId = queue.enqueue(makeInput({ itemId: 'dead', priority: 10 }))
      for (let i = 0; i < DEFAULT_MAX_ATTEMPTS; i++) {
        simulateFailedAttempt(queue, deadId, 'fail')
      }

      // #given retryable item (medium priority, dequeued next)
      const retryId = queue.enqueue(makeInput({ itemId: 'retry', priority: 5 }))
      simulateFailedAttempt(queue, retryId, 'err')

      // #given fresh item (never dequeued)
      queue.enqueue(makeInput({ itemId: 'fresh' }))

      // #when
      const retryable = queue.getRetryableItems()

      // #then only the failed-but-not-dead item
      expect(retryable).toHaveLength(1)
      expect(retryable[0].itemId).toBe('retry')
    })

    it('accepts custom maxAttempts', () => {
      // #given item with 2 attempts
      const id = queue.enqueue(makeInput())
      simulateFailedAttempt(queue, id, 'err-1')
      simulateFailedAttempt(queue, id, 'err-2')

      // #when getRetryableItems with maxAttempts=2
      const retryable = queue.getRetryableItems(2)

      // #then excluded because attempts === maxAttempts
      expect(retryable).toHaveLength(0)
    })
  })

  describe('persistence', () => {
    it('items persist across SyncQueueManager instances', () => {
      // #given items enqueued via first instance
      queue.enqueue(makeInput({ itemId: 'persist-1' }))
      queue.enqueue(makeInput({ itemId: 'persist-2' }))

      // #when new manager with same db
      const queue2 = new SyncQueueManager(testDb.db)

      // #then items visible
      expect(queue2.getSize()).toBe(2)
      const items = queue2.peek(2)
      const ids = items.map((i) => i.itemId)
      expect(ids).toContain('persist-1')
      expect(ids).toContain('persist-2')
    })
  })

  describe('dequeue/getPendingCount consistency', () => {
    it('dequeue finds items enqueued after a previous empty dequeue', () => {
      // #given first dequeue returns nothing
      expect(queue.dequeue(100)).toHaveLength(0)

      // #when manifest check enqueues 2 items
      queue.enqueue(makeInput({ type: 'inbox', itemId: 'inbox-1', operation: 'create' }))
      queue.enqueue(makeInput({ type: 'inbox', itemId: 'inbox-2', operation: 'create' }))

      // #then getPendingCount and dequeue agree
      const pending = queue.getPendingCount()
      const items = queue.dequeue(100)
      expect(pending).toBe(2)
      expect(items).toHaveLength(2)
    })

    it('dequeue finds new items even when old failed items exist for same itemId', () => {
      // #given old items from previous session with attempts > 0
      queue.enqueue(
        makeInput({ type: 'inbox', itemId: 'inbox-1', operation: 'create', payload: '{"v":1}' })
      )
      queue.dequeue(1)

      // #when manifest re-enqueues same item (creates new row since attempts > 0)
      queue.enqueue(
        makeInput({ type: 'inbox', itemId: 'inbox-1', operation: 'create', payload: '{"v":2}' })
      )

      // #then getPendingCount matches dequeue count
      const pending = queue.getPendingCount()
      const items = queue.dequeue(100)
      expect(pending).toBe(items.length)
      expect(items.length).toBeGreaterThanOrEqual(1)
    })
  })
})
