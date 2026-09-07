import { describe, expect, it, vi } from 'vitest'
import type { VaultDb } from '../../db/index'
import { OutboxStore } from '../outbox'

function fakeDb() {
  const events: string[] = []
  const db = {
    runAsync: vi.fn(async () => {
      events.push('write')
      return { changes: 1, lastInsertRowId: 1 }
    })
  } as unknown as VaultDb
  return { db, events }
}

describe('OutboxStore enqueue notifications', () => {
  it('notifies after a record write is queued', async () => {
    const { db, events } = fakeDb()
    const notify = vi.fn(() => events.push('notify'))
    const store = new OutboxStore(db, notify)

    await store.enqueueRecord('note', 'note-1', 'update', '{}')

    expect(events).toEqual(['write', 'write', 'notify'])
    expect(notify).toHaveBeenCalledOnce()
  })

  it('notifies after a CRDT write is queued', async () => {
    const { db, events } = fakeDb()
    const notify = vi.fn(() => events.push('notify'))
    const store = new OutboxStore(db, notify)

    await store.enqueueCrdtUpdate('note-1', new Uint8Array([1]))

    expect(events).toEqual(['write', 'notify'])
    expect(notify).toHaveBeenCalledOnce()
  })
})
