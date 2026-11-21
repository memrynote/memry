import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { recordTombstoneClock } from '@memry/sync-client/tombstone-clocks'
import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { createTestDataDb } from '../../test/helpers/test-data-db'
import { runReviveHeal, type ReviveHealDeps } from './revive-heal'

const DAY = 'j2099-06-15'

/**
 * The author on a build before #5358: the day written and pushed (server
 * seq 1), deleted with its doc kept, and written again on that doc (seq 2).
 * The server purged seq 1 with the delete.
 */
function shippedRevive(): { author: Y.Doc; purged: Uint8Array; revived: Uint8Array } {
  const author = new Y.Doc()
  author.getText('body').insert(0, 'Deleted words.')
  const purged = Y.encodeStateAsUpdate(author)
  const before = Y.encodeStateVector(author)
  author.getText('body').insert(14, ' Back again.')
  return { author, purged, revived: Y.encodeStateAsUpdate(author, before) }
}

function freshDevice(updates: Uint8Array[]): { text: string; pending: boolean } {
  const doc = new Y.Doc()
  for (const update of updates) Y.applyUpdate(doc, update)
  return {
    text: doc.getText('body').toJSON(),
    pending: doc.store.pendingStructs !== null || doc.store.pendingDs !== null
  }
}

describe('runReviveHeal', () => {
  let db: DrizzleDb
  let queued: Uint8Array[]
  let deps: ReviveHealDeps
  let shipped: ReturnType<typeof shippedRevive>

  beforeEach(() => {
    db = createTestDataDb()
    recordTombstoneClock(db, 'journal', DAY, { 'device-b': 2 })
    shipped = shippedRevive()
    queued = []
    deps = {
      db,
      isNoteSyncable: () => true,
      hasQueuedChange: () => false,
      readServerBody: vi.fn(async () => [shipped.revived]),
      readLocalState: async () => Y.encodeStateAsUpdate(shipped.author),
      enqueueFullState: () => queued.push(Y.encodeStateAsUpdate(shipped.author))
    }
  })

  it('re-pushes the full state of a day the server holds pending, once', async () => {
    expect(freshDevice([shipped.revived])).toEqual({ text: '', pending: true })

    expect(await runReviveHeal(deps)).toBe(1)
    const healed = freshDevice([shipped.revived, ...queued])
    expect(healed.pending).toBe(false)
    // Accepted (#5354): the deleted text returns beside the new text.
    expect(healed.text).toBe('Deleted words. Back again.')

    expect(await runReviveHeal(deps)).toBe(0)
    expect(deps.readServerBody).toHaveBeenCalledTimes(1)
    expect(queued).toHaveLength(1)
  })

  it('pushes nothing when the server body integrates on its own', async () => {
    deps.readServerBody = vi.fn(async () => [shipped.purged, shipped.revived])
    expect(await runReviveHeal(deps)).toBe(0)
    expect(queued).toHaveLength(0)
  })

  it('waits for a queued change to be pushed before reading the server', async () => {
    deps.hasQueuedChange = () => true
    expect(await runReviveHeal(deps)).toBe(0)
    expect(deps.readServerBody).not.toHaveBeenCalled()
  })

  it('pushes nothing when the local state cannot complete the server body', async () => {
    deps.readLocalState = async () => null
    expect(await runReviveHeal(deps)).toBe(0)
    expect(queued).toHaveLength(0)
  })
})
