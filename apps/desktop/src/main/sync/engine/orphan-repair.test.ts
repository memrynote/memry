import { describe, it, expect, vi, beforeEach } from 'vitest'
import { repairOrphans, type OrphanRef } from './orphan-repair'
import type { SyncContext } from './sync-context'
import type { CorruptItemTracker } from './corrupt-item-tracker'

const fetchLocal = vi.fn()

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

function makeTracker(recovered: unknown[] = []): CorruptItemTracker {
  return {
    clearExpired: vi.fn(),
    refetch: vi.fn(async () => ({ recovered, permanentFailures: [] }))
  } as unknown as CorruptItemTracker
}

const VAULT_KEY = new Uint8Array(32)

describe('repairOrphans (#837)', () => {
  beforeEach(() => {
    fetchLocal.mockReset()
  })

  it('does nothing when there are no orphans', async () => {
    const ctx = makeCtx()
    const tracker = makeTracker()

    const result = await repairOrphans({
      orphans: [],
      ctx,
      corruptTracker: tracker,
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

  // The parent is gone locally AND the server does not return it, so the child
  // can never be written. Tombstoning it is what the cascade should have pushed
  // in the first place, and it ends the re-pull loop on every device.
  it('tombstones the child when the parent is gone server-side', async () => {
    const ctx = makeCtx()
    const tracker = makeTracker([])
    fetchLocal.mockReturnValue(undefined)

    const result = await repairOrphans({
      orphans: [makeOrphan()],
      ctx,
      corruptTracker: tracker,
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

  it('stamps the tombstone with a clock that outranks the server copy', async () => {
    // #given an orphan whose content still carries the clock it was pulled with
    const ctx = makeCtx()
    fetchLocal.mockReturnValue(undefined)
    const pulled = { title: 'Orphan', clock: { 'device-A': 4, 'device-B': 2 } }

    await repairOrphans({
      orphans: [makeOrphan({ item: { ...makeOrphan().item, content: JSON.stringify(pulled) } })],
      ctx,
      corruptTracker: makeTracker([]),
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
      corruptTracker: makeTracker([]),
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
    const tracker = makeTracker([])
    fetchLocal.mockReturnValue(undefined)

    await repairOrphans({
      orphans: [
        makeOrphan({ item: { ...makeOrphan().item, id: 'task-1' } }),
        makeOrphan({ item: { ...makeOrphan().item, id: 'task-2' } }),
        makeOrphan({ item: { ...makeOrphan().item, id: 'task-3' } })
      ],
      ctx,
      corruptTracker: tracker,
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
      accessJwt: 'jwt',
      vaultKey: VAULT_KEY,
      applyItem: vi.fn(() => {
        throw new Error('still broken')
      })
    })

    expect(result).toEqual({ repaired: 0, tombstoned: 0 })
    expect(ctx.deps.queue.enqueue).not.toHaveBeenCalled()
  })
})
