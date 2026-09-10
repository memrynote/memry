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

describe('OutboxStore.pendingCountForItem', () => {
  it('counts only the rows belonging to the note it was asked about', async () => {
    const getFirstAsync = vi.fn(async () => ({ n: 3 }))
    const db = { getFirstAsync } as unknown as VaultDb
    const store = new OutboxStore(db)

    expect(await store.pendingCountForItem('note-1')).toBe(3)
    const [sql, params] = getFirstAsync.mock.calls[0] as unknown as [string, unknown[]]
    // Scope is the whole point: the note screen's indicator would report every
    // other note's backlog as this note's if the filter went missing.
    expect(sql).toContain('WHERE item_id = ?')
    expect(params).toEqual(['note-1'])
  })

  it('reads an empty queue as zero rather than undefined', async () => {
    const db = { getFirstAsync: vi.fn(async () => null) } as unknown as VaultDb
    expect(await new OutboxStore(db).pendingCountForItem('note-1')).toBe(0)
  })
})
