import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { repairOrphans, type OrphanRef } from './orphan-repair'
import { CORRUPT_ITEM_COOLDOWN_MS, type SyncContext } from './sync-context'
import { CorruptItemTracker, type RefetchResult } from './corrupt-item-tracker'
import type { QuarantineManager } from './quarantine-manager'
import { postToServer } from '../http-client'
import type { SchemaInvalidLedger } from './schema-invalid-ledger'
import { PendingSyncIntentError } from '../pending-sync-intent-error'

const fetchLocal = vi.fn()

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))
vi.mock('../http-client', () => ({ postToServer: vi.fn() }))
vi.mock('@memry/sync-client/retry', () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => ({ value: await fn() }))
}))
vi.mock('../sync-crypto-batch', () => ({
  decryptPullBatch: vi.fn(async () => ({ decrypted: [], failures: [] }))
}))

vi.mock('../item-handlers', () => ({
  getHandler: (type: string) => (type === 'project' ? { fetchLocal } : undefined)
}))

function makeOrphan(overrides: Partial<OrphanRef> = {}): OrphanRef {
  return {
    item: {
      id: 'task-1',
      type: 'task',
      content: '{"title":"Orphan"}',
      clock: { 'device-A': 1 },
      operation: 'update'
    } as OrphanRef['item'],
    parentType: 'project',
    parentId: 'proj-gone',
    ...overrides
  }
}

function makeCtx(signingKeys: { deviceId: string } | null = { deviceId: 'device-B' }): SyncContext {
  return {
    applier: { apply: vi.fn() },
    requestPush: vi.fn(),
    deps: {
      db: {},
      queue: { enqueue: vi.fn() },
      // A tombstone has to be stamped with THIS device's clock to outrank the
      // server's copy, so the repair needs the signing keys.
      getSigningKeys: vi.fn(async () => signingKeys)
    }
  } as unknown as SyncContext
}

function makeTracker(
  recovered: unknown[] = [],
  answer: Partial<RefetchResult> = {}
): CorruptItemTracker {
  return {
    clearExpired: vi.fn(),
    refetch: vi.fn(async () => ({
      recovered,
      permanentFailures: [],
      missing: [],
      invalid: [],
      blobMissing: [],
      skipped: [],
      ...answer
    }))
  } as unknown as CorruptItemTracker
}

/** The server positively says the parent is gone: requested, and no live row served. */
const PARENT_GONE: Partial<RefetchResult> = { missing: [{ id: 'proj-gone', type: 'project' }] }

const VAULT_KEY = new Uint8Array(32)
const ledgerHas = vi.fn((_type: string, _id: string) => false)
const ledger = { record: vi.fn(), has: ledgerHas } as unknown as SchemaInvalidLedger

describe('repairOrphans (#837)', () => {
  beforeEach(() => {
    fetchLocal.mockReset()
    ledgerHas.mockReset()
    ledgerHas.mockReturnValue(false)
  })

  it('does nothing when there are no orphans', async () => {
    const ctx = makeCtx()
    const tracker = makeTracker()

    const result = await repairOrphans({
      orphans: [],
      ctx,
      corruptTracker: tracker,
      schemaInvalid: ledger,
      accessJwt: 'jwt',
      vaultKey: VAULT_KEY,
      applyItem: vi.fn()
    })

    expect(result).toEqual({ repaired: 0, tombstoned: 0 })
    expect(tracker.refetch).not.toHaveBeenCalled()
  })

  // The server still has the parent — it just sat outside this run's cursor
  // window. Applying it and retrying the child is the whole repair; nothing
  // should be deleted.
  it('applies a refetched parent and re-applies the child', async () => {
    const ctx = makeCtx()
    const tracker = makeTracker([
      {
        id: 'proj-gone',
        type: 'project',
        content: '{"name":"Recovered"}',
        clock: {},
        operation: 'update'
      }
    ])
    fetchLocal.mockReturnValue({ id: 'proj-gone' })
    const applyItem = vi.fn()

    const result = await repairOrphans({
      orphans: [makeOrphan()],
      ctx,
      corruptTracker: tracker,
      schemaInvalid: ledger,
      accessJwt: 'jwt',
      vaultKey: VAULT_KEY,
      applyItem
    })

    expect(result).toEqual({ repaired: 1, tombstoned: 0 })
    expect(ctx.applier.apply).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'proj-gone', type: 'project' })
    )
    expect(applyItem).toHaveBeenCalledTimes(1)
    expect(ctx.deps.queue.enqueue).not.toHaveBeenCalled()
  })

  // #2301 review r2 A-L3: a child that still waits on its local sync intent
  // is deferred to the ledger, not reported as a failed repair.
  it('routes a restored child with a pending sync intent to the ledger', async () => {
    const ctx = makeCtx()
    fetchLocal.mockReturnValue({ id: 'proj-gone' })
    const orphan = makeOrphan()
    const applyItem = vi.fn(() => {
      throw new PendingSyncIntentError('task', 'task-1')
    })
    vi.mocked(ledger.record).mockClear()

    const result = await repairOrphans({
      orphans: [orphan],
      ctx,
      corruptTracker: makeTracker(),
      schemaInvalid: ledger,
      accessJwt: 'jwt',
      vaultKey: VAULT_KEY,
      applyItem
    })

    expect(result).toEqual({ repaired: 0, tombstoned: 0 })
    expect(ledger.record).toHaveBeenCalledWith([orphan.item], 'pending_intent')
  })

  // The parent is gone locally AND the server does not return it, so the child
  // can never be written. Tombstoning it is what the cascade should have pushed
  // in the first place, and it ends the re-pull loop on every device.
  it('tombstones the child when the parent is gone server-side', async () => {
    const ctx = makeCtx()
    const tracker = makeTracker([], PARENT_GONE)
    fetchLocal.mockReturnValue(undefined)

    const result = await repairOrphans({
      orphans: [makeOrphan()],
      ctx,
      corruptTracker: tracker,
      schemaInvalid: ledger,
      accessJwt: 'jwt',
      vaultKey: VAULT_KEY,
      applyItem: vi.fn()
    })

    expect(result).toEqual({ repaired: 0, tombstoned: 1 })
    expect(ctx.deps.queue.enqueue).toHaveBeenCalledWith({
      type: 'task',
      itemId: 'task-1',
      operation: 'delete',
      payload: '{"title":"Orphan","clock":{"device-B":1}}',
      priority: 0
    })
    expect(ctx.requestPush).toHaveBeenCalled()
  })

  // #2285: the parent is on the server but this build refuses its payload.
  // Tombstoning the child would delete it on every device.
  it('keeps the child when the server still has a parent this build cannot apply', async () => {
    const ctx = makeCtx()
    vi.mocked(ctx.applier.apply).mockReturnValue('schema_invalid')
    const tracker = makeTracker([
      { id: 'proj-gone', type: 'project', content: '{}', clock: {}, operation: 'update' }
    ])
    fetchLocal.mockReturnValue(undefined)

    const result = await repairOrphans({
      orphans: [makeOrphan()],
      ctx,
      corruptTracker: tracker,
      schemaInvalid: ledger,
      accessJwt: 'jwt',
      vaultKey: VAULT_KEY,
      applyItem: vi.fn()
    })

    expect(result).toEqual({ repaired: 0, tombstoned: 0 })
    expect(ctx.deps.queue.enqueue).not.toHaveBeenCalled()
    expect(ledger.record).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'proj-gone', type: 'project' })],
      'payload'
    )
  })

  it('still tombstones the child when the server returns the parent as deleted', async () => {
    const ctx = makeCtx()
    vi.mocked(ctx.applier.apply).mockReturnValue('applied')
    const tracker = makeTracker([
      {
        id: 'proj-gone',
        type: 'project',
        content: '{}',
        clock: {},
        operation: 'delete',
        deletedAt: 5
      }
    ])
    fetchLocal.mockReturnValue(undefined)

    const result = await repairOrphans({
      orphans: [makeOrphan()],
      ctx,
      corruptTracker: tracker,
      schemaInvalid: ledger,
      accessJwt: 'jwt',
      vaultKey: VAULT_KEY,
      applyItem: vi.fn()
    })

    expect(result).toEqual({ repaired: 0, tombstoned: 1 })
  })

  // #2302: a lost parent blob is a live parent, not a deleted one. Tombstoning
  // its children would push their deletes to every device.
  it('keeps the child when the server reports the parent blob as missing', async () => {
    const ctx = makeCtx()
    const tracker = makeTracker([], { blobMissing: [{ id: 'proj-gone', type: 'project' }] })
    fetchLocal.mockReturnValue(undefined)
    vi.mocked(ledger.record).mockClear()

    const result = await repairOrphans({
      orphans: [makeOrphan()],
      ctx,
      corruptTracker: tracker,
      schemaInvalid: ledger,
      accessJwt: 'jwt',
      vaultKey: VAULT_KEY,
      applyItem: vi.fn()
    })

    expect(result).toEqual({ repaired: 0, tombstoned: 0 })
    expect(ctx.deps.queue.enqueue).not.toHaveBeenCalled()
    expect(ctx.applier.apply).not.toHaveBeenCalled()
    expect(ledger.record).toHaveBeenCalledWith(
      [{ id: 'proj-gone', type: 'project' }],
      'blob_missing'
    )
  })

  // #2302: a purged parent tombstone goes through the clock-guarded delete. When
  // the local parent happens strictly after it, the handler keeps it, and the
  // child is re-applied instead of tombstoned.
  it('re-applies the child when the purged parent tombstone was skipped by the local clock', async () => {
    const ctx = makeCtx()
    vi.mocked(ctx.applier.apply).mockReturnValue('skipped')
    const tracker = makeTracker([
      {
        id: 'proj-gone',
        type: 'project',
        content: '',
        clock: { 'device-A': 1 },
        operation: 'delete',
        deletedAt: 5,
        signerDeviceId: ''
      }
    ])
    fetchLocal.mockReturnValue({ id: 'proj-gone' })
    const applyItem = vi.fn()

    const result = await repairOrphans({
      orphans: [makeOrphan()],
      ctx,
      corruptTracker: tracker,
      schemaInvalid: ledger,
      accessJwt: 'jwt',
      vaultKey: VAULT_KEY,
      applyItem
    })

    expect(ctx.applier.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'proj-gone',
        operation: 'delete',
        clock: { 'device-A': 1 }
      })
    )
    expect(result).toEqual({ repaired: 1, tombstoned: 0 })
    expect(applyItem).toHaveBeenCalledTimes(1)
    expect(ctx.deps.queue.enqueue).not.toHaveBeenCalled()
  })

  it('stamps the tombstone with a clock that outranks the server copy', async () => {
    // #given an orphan whose content still carries the clock it was pulled with
    const ctx = makeCtx()
    fetchLocal.mockReturnValue(undefined)
    const pulled = { title: 'Orphan', clock: { 'device-A': 4, 'device-B': 2 } }

    await repairOrphans({
      orphans: [makeOrphan({ item: { ...makeOrphan().item, content: JSON.stringify(pulled) } })],
      ctx,
      corruptTracker: makeTracker([], PARENT_GONE),
      schemaInvalid: ledger,
      accessJwt: 'jwt',
      vaultKey: VAULT_KEY,
      applyItem: vi.fn()
    })

    // #then the server rejects any push whose clock has no entry greater than the
    // one it already holds, and this payload IS the server's own clock — sent back
    // unchanged the delete comes home SYNC_REPLAY_DETECTED every cycle, the next
    // pull re-serves the orphan, and this repair runs forever.
    const [enqueued] = (ctx.deps.queue.enqueue as ReturnType<typeof vi.fn>).mock.calls[0]
    const clock = JSON.parse(enqueued.payload).clock as Record<string, number>
    expect(clock['device-B']).toBeGreaterThan(pulled.clock['device-B'])
    expect(clock['device-A']).toBe(4)
  })

  it('leaves the orphan for the next pull when there is no device id', async () => {
    // #given signing keys are unavailable (locked keychain, teardown)
    const ctx = makeCtx(null)
    fetchLocal.mockReturnValue(undefined)

    const result = await repairOrphans({
      orphans: [makeOrphan()],
      ctx,
      corruptTracker: makeTracker([], PARENT_GONE),
      schemaInvalid: ledger,
      accessJwt: 'jwt',
      vaultKey: VAULT_KEY,
      applyItem: vi.fn()
    })

    // #then an unstamped tombstone would just be a replay again, so spending a
    // push proving that is worse than waiting for the next pull.
    expect(result).toEqual({ repaired: 0, tombstoned: 0 })
    expect(ctx.deps.queue.enqueue).not.toHaveBeenCalled()
    expect(ctx.requestPush).not.toHaveBeenCalled()
  })

  it('refetches each distinct parent once for many orphans', async () => {
    const ctx = makeCtx()
    const tracker = makeTracker([], PARENT_GONE)
    fetchLocal.mockReturnValue(undefined)

    await repairOrphans({
      orphans: [
        makeOrphan({ item: { ...makeOrphan().item, id: 'task-1' } }),
        makeOrphan({ item: { ...makeOrphan().item, id: 'task-2' } }),
        makeOrphan({ item: { ...makeOrphan().item, id: 'task-3' } })
      ],
      ctx,
      corruptTracker: tracker,
      schemaInvalid: ledger,
      accessJwt: 'jwt',
      vaultKey: VAULT_KEY,
      applyItem: vi.fn()
    })

    expect(tracker.refetch).toHaveBeenCalledWith(
      [{ id: 'proj-gone', type: 'project' }],
      'jwt',
      VAULT_KEY
    )
    expect(ctx.deps.queue.enqueue).toHaveBeenCalledTimes(3)
  })

  // A child that fails again after its parent was restored must not be deleted
  // — the failure is something other than the missing parent.
  it('does not tombstone when the re-apply throws but the parent exists', async () => {
    const ctx = makeCtx()
    const tracker = makeTracker([])
    fetchLocal.mockReturnValue({ id: 'proj-gone' })

    const result = await repairOrphans({
      orphans: [makeOrphan()],
      ctx,
      corruptTracker: tracker,
      schemaInvalid: ledger,
      accessJwt: 'jwt',
      vaultKey: VAULT_KEY,
      applyItem: vi.fn(() => {
        throw new Error('still broken')
      })
    })

    expect(result).toEqual({ repaired: 0, tombstoned: 0 })
    expect(ctx.deps.queue.enqueue).not.toHaveBeenCalled()
  })

  // #2302 review (B-1): "not returned" is not "gone".
  it('keeps the child when the parent was neither returned nor reported missing', async () => {
    const ctx = makeCtx()
    fetchLocal.mockReturnValue(undefined)

    const result = await repairOrphans({
      orphans: [makeOrphan()],
      ctx,
      corruptTracker: makeTracker([], { skipped: [{ id: 'proj-gone', type: 'project' }] }),
      schemaInvalid: ledger,
      accessJwt: 'jwt',
      vaultKey: VAULT_KEY,
      applyItem: vi.fn()
    })

    expect(result).toEqual({ repaired: 0, tombstoned: 0 })
    expect(ctx.deps.queue.enqueue).not.toHaveBeenCalled()
  })

  // #2302 review (B-1): the ledger still holds the parent, so the server has a
  // live row for it this build could not use.
  it('keeps the child when the parent is in the schema-invalid ledger, even if reported missing', async () => {
    const ctx = makeCtx()
    fetchLocal.mockReturnValue(undefined)
    ledgerHas.mockReturnValue(true)

    const result = await repairOrphans({
      orphans: [makeOrphan()],
      ctx,
      corruptTracker: makeTracker([], PARENT_GONE),
      schemaInvalid: ledger,
      accessJwt: 'jwt',
      vaultKey: VAULT_KEY,
      applyItem: vi.fn()
    })

    expect(result).toEqual({ repaired: 0, tombstoned: 0 })
    expect(ledgerHas).toHaveBeenCalledWith('project', 'proj-gone')
  })

  // #2302 review (B-1): a delete the parent's handler refused (not 'applied') is not proof.
  it('keeps the child when the parent delete was served but not applied', async () => {
    const ctx = makeCtx()
    vi.mocked(ctx.applier.apply).mockReturnValue('skipped')
    fetchLocal.mockReturnValue(undefined)

    const result = await repairOrphans({
      orphans: [makeOrphan()],
      ctx,
      corruptTracker: makeTracker([
        {
          id: 'proj-gone',
          type: 'project',
          content: '',
          clock: { 'device-A': 1 },
          operation: 'delete',
          deletedAt: 5
        }
      ]),
      schemaInvalid: ledger,
      accessJwt: 'jwt',
      vaultKey: VAULT_KEY,
      applyItem: vi.fn()
    })

    expect(result).toEqual({ repaired: 0, tombstoned: 0 })
  })
})

// #2302 review (B-1): the tracker's cooldown used to make a lost-blob parent
// vanish from the second refetch, and "vanished" was read as "gone".
describe('repairOrphans with a real CorruptItemTracker (#2302)', () => {
  const realTracker = (ctx: SyncContext) =>
    new CorruptItemTracker(
      {
        ...ctx,
        abortController: null,
        deps: { ...ctx.deps, network: { online: true }, workerBridge: undefined }
      } as unknown as SyncContext,
      { quarantineItem: vi.fn() } as unknown as QuarantineManager,
      vi.fn(async () => new Uint8Array(32))
    )

  const run = (ctx: SyncContext, tracker: CorruptItemTracker) =>
    repairOrphans({
      orphans: [makeOrphan()],
      ctx,
      corruptTracker: tracker,
      schemaInvalid: ledger,
      accessJwt: 'jwt',
      vaultKey: VAULT_KEY,
      applyItem: vi.fn()
    })

  beforeEach(() => {
    fetchLocal.mockReset()
    fetchLocal.mockReturnValue(undefined)
    ledgerHas.mockReset()
    ledgerHas.mockReturnValue(false)
    vi.mocked(postToServer).mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps the child across two runs inside the cooldown of a lost-blob parent', async () => {
    const ctx = makeCtx()
    const tracker = realTracker(ctx)
    vi.mocked(postToServer).mockResolvedValue({
      items: [],
      blobMissing: [{ id: 'proj-gone', type: 'project', serverCursor: 1 }]
    })

    const first = await run(ctx, tracker)
    const second = await run(ctx, tracker)

    expect(first).toEqual({ repaired: 0, tombstoned: 0 })
    expect(second).toEqual({ repaired: 0, tombstoned: 0 })
    // The second run never asked: the parent sat on the cooldown.
    expect(postToServer).toHaveBeenCalledTimes(1)
    expect(ctx.deps.queue.enqueue).not.toHaveBeenCalled()
  })

  it('tombstones the child once a later run gets a positive "gone" answer', async () => {
    const ctx = makeCtx()
    const tracker = realTracker(ctx)
    const start = Date.now()
    const now = vi.spyOn(Date, 'now').mockReturnValue(start)
    vi.mocked(postToServer)
      .mockResolvedValueOnce({
        items: [],
        blobMissing: [{ id: 'proj-gone', type: 'project', serverCursor: 1 }]
      })
      .mockResolvedValueOnce({ items: [] })

    await run(ctx, tracker)
    now.mockReturnValue(start + CORRUPT_ITEM_COOLDOWN_MS + 1)
    const later = await run(ctx, tracker)

    expect(later).toEqual({ repaired: 0, tombstoned: 1 })
  })

  // #2408: a parent tombstone no device attested is never applied or recovered
  // as a delete. Orphan repair already trusts server absence, so the child is
  // handled exactly as when the server returns nothing for the parent.
  it('never applies a forged purged parent tombstone; the child is handled as for an absent parent', async () => {
    const outcome = async (pullBody: Record<string, unknown>) => {
      const ctx = makeCtx()
      vi.mocked(postToServer).mockResolvedValueOnce(pullBody)
      const result = await run(ctx, realTracker(ctx))
      return {
        result,
        applied: vi.mocked(ctx.applier.apply).mock.calls,
        enqueued: vi.mocked(ctx.deps.queue.enqueue).mock.calls
      }
    }

    const forged = await outcome({
      items: [],
      purgedTombstones: [
        {
          id: 'proj-gone',
          type: 'project',
          deletedAt: 5,
          clock: { x: 2 ** 31 },
          serverCursor: 1,
          signerDeviceId: 'device-A',
          deleteAttestation: Buffer.alloc(64, 7).toString('base64')
        }
      ]
    })
    const absent = await outcome({ items: [] })

    expect(forged.applied).toEqual([])
    expect(forged).toEqual(absent)
  })
})
