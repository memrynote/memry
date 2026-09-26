import { describe, expect, it, vi } from 'vitest'
import {
  refetchCorruptItems,
  retrySchemaInvalidItems,
  type ItemRecoveryDeps
} from './item-recovery'
import { SchemaInvalidLedger } from './schema-invalid-ledger'
import { PendingSyncIntentError } from '../pending-sync-intent-error'
import { trackMainLog } from '../../telemetry/diagnostics'
import type { CorruptItemTracker, RecoveredItem, RefetchResult } from './corrupt-item-tracker'
import {
  CORRUPT_ITEM_COOLDOWN_MS,
  MAX_NOTE_BODY_HEALS_PER_PULL,
  type SyncContext
} from './sync-context'
import type { SyncStateManager } from './sync-state-manager'

vi.mock('../../lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { createLogger: () => logger }
})
vi.mock('../../telemetry/diagnostics', () => ({ trackMainLog: vi.fn() }))
vi.mock('./conflict-report', () => ({ reportConflict: vi.fn() }))

const recovered = (id: string, type = 'task'): RecoveredItem => ({
  id,
  type,
  content: '{}',
  operation: 'update'
})

function harness(results: Record<string, string | Error>, refetch: Partial<RefetchResult>) {
  const state = new Map<string, string>()
  const stateManager = {
    getStateValue: (key: string) => state.get(key),
    setStateValue: (key: string, value: string) => state.set(key, value)
  } as unknown as SyncStateManager
  const version = { current: '1.0.0' }
  const ledger = new SchemaInvalidLedger(stateManager, () => version.current)
  const applied: string[] = []
  const apply = vi.fn((input: { itemId: string }) => {
    applied.push(input.itemId)
    const result = results[input.itemId]
    if (result instanceof Error) throw result
    return result
  })
  const tracker = {
    refetch: vi.fn(async (): Promise<RefetchResult> => ({
      recovered: [],
      permanentFailures: [],
      missing: [],
      invalid: [],
      blobMissing: [],
      skipped: [],
      ...refetch
    })),
    markFailed: vi.fn(),
    clearExpired: vi.fn()
  }
  const onChanged = vi.fn()
  const pullNoteBody = vi.fn(async (noteId: string) => noteId !== 'note-still-bad')
  const deps: ItemRecoveryDeps = {
    ctx: { applier: { apply }, deps: { emitToRenderer: vi.fn() } } as unknown as SyncContext,
    tracker: tracker as unknown as CorruptItemTracker,
    ledger,
    onChanged,
    pullNoteBody
  }
  return { deps, ledger, tracker, version, applied, onChanged, pullNoteBody }
}

// #2285
describe('retrySchemaInvalidItems', () => {
  it('routes every re-fetched outcome back into the ledger after an app update', async () => {
    const h = harness(
      {
        'task-fixed': 'applied',
        'task-still-bad': 'schema_invalid',
        'task-threw': new Error('missing parent'),
        'project-1': 'skipped'
      },
      {
        recovered: [
          recovered('task-fixed'),
          recovered('task-still-bad'),
          recovered('task-threw'),
          recovered('project-1', 'project')
        ],
        missing: [{ id: 'task-gone', type: 'task' }],
        invalid: [{ id: 'task-envelope', type: 'task' }]
      }
    )
    h.ledger.record(
      ['task-fixed', 'task-still-bad', 'task-threw', 'task-gone', 'task-envelope'].map((id) => ({
        id,
        type: 'task'
      })),
      'payload'
    )
    h.ledger.record([{ id: 'project-1', type: 'project' }], 'payload')
    h.version.current = '1.1.0'

    await retrySchemaInvalidItems(h.deps, 'token', new Uint8Array(32))

    expect(h.tracker.refetch).toHaveBeenCalledTimes(1)
    expect(h.applied[0]).toBe('project-1')
    expect(h.onChanged).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-fixed' }),
      'update'
    )
    expect(h.onChanged).toHaveBeenCalledTimes(1)
    expect(h.tracker.markFailed).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-threw' }))
    expect(
      h.ledger
        .quarantinedItems()
        .map((item) => `${item.itemId} ${item.lastError}`)
        .sort()
    ).toEqual([
      'task-envelope schema_invalid:envelope (app 1.1.0)',
      'task-still-bad schema_invalid:payload (app 1.1.0)',
      'task-threw schema_invalid:payload (app 1.0.0)'
    ])
  })

  // #2302: a lost blob that is still lost stays in the ledger; one the server
  // no longer returns at all leaves it; one that healed applies and leaves it.
  it('keeps a still-missing blob in the ledger and resolves a healed one', async () => {
    vi.useFakeTimers()
    const h = harness(
      { 'task-healed': 'applied' },
      {
        recovered: [recovered('task-healed')],
        blobMissing: [{ id: 'task-lost', type: 'task' }]
      }
    )
    h.ledger.record(
      ['task-lost', 'task-healed'].map((id) => ({ id, type: 'task' })),
      'blob_missing'
    )
    vi.advanceTimersByTime(CORRUPT_ITEM_COOLDOWN_MS + 1)

    await retrySchemaInvalidItems(h.deps, 'token', new Uint8Array(32))
    vi.useRealTimers()

    expect(h.tracker.refetch).toHaveBeenCalledWith(
      [
        { id: 'task-lost', type: 'task' },
        { id: 'task-healed', type: 'task' }
      ],
      'token',
      expect.any(Uint8Array)
    )
    expect(h.ledger.has('task', 'task-lost')).toBe(true)
    expect(h.ledger.has('task', 'task-healed')).toBe(false)
    expect(h.ledger.retryable()).toEqual([])
  })

  it('does not call the server when nothing is retryable', async () => {
    const h = harness({}, {})
    h.ledger.record([{ id: 'task-1', type: 'task' }], 'payload')

    await retrySchemaInvalidItems(h.deps, 'token', new Uint8Array(32))

    expect(h.tracker.refetch).not.toHaveBeenCalled()
  })

  // #2302 with #2294: the page's corrupt re-fetch quarantines a lost blob, so
  // the manifest does not count it server-only.
  it('refetchCorruptItems records a lost blob in the ledger', async () => {
    const h = harness({}, { blobMissing: [{ id: 'task-lost', type: 'task' }] })

    await refetchCorruptItems(
      h.deps,
      [{ id: 'task-lost', type: 'task' }],
      'token',
      new Uint8Array(32)
    )

    expect(h.ledger.has('task', 'task-lost')).toBe(true)
    expect(h.ledger.quarantinedItems()[0].lastError).toContain('blob_missing')
  })

  // #2301 review r2 A-L3/B-2: an item whose local edit is still waiting on
  // its sync intent is not corrupt and not dropped: it goes back to the
  // ledger and is re-fetched at the next pull start.
  it('routes an item with a pending sync intent back to the ledger, not to the corrupt tracker', async () => {
    const h = harness(
      { 'task-waiting': new PendingSyncIntentError('task', 'task-waiting') },
      { recovered: [recovered('task-waiting')] }
    )
    h.ledger.record([{ id: 'task-waiting', type: 'task' }], 'pending_intent')
    vi.mocked(trackMainLog).mockClear()

    await retrySchemaInvalidItems(h.deps, 'token', new Uint8Array(32))

    expect(h.tracker.markFailed).not.toHaveBeenCalled()
    expect(trackMainLog).not.toHaveBeenCalled()
    expect(h.ledger.has('task', 'task-waiting')).toBe(true)
    expect(h.ledger.retryable()).toEqual([{ id: 'task-waiting', type: 'task' }])
  })

  // #2297: a note body has no record to re-fetch by id. /sync/pull would answer
  // the note record, so the entry is healed by a whole-body pull instead.
  it('re-pulls a note body entry whole and never asks /sync/pull for it', async () => {
    const h = harness({}, {})
    h.ledger.record(
      [
        { id: 'note-fixed', type: 'note_body' },
        { id: 'note-still-bad', type: 'note_body' }
      ],
      'payload'
    )
    h.version.current = '1.1.0'

    await retrySchemaInvalidItems(h.deps, 'token', new Uint8Array(32))

    expect(h.tracker.refetch).not.toHaveBeenCalled()
    expect(h.pullNoteBody.mock.calls.map(([noteId]) => noteId)).toEqual([
      'note-fixed',
      'note-still-bad'
    ])
    expect(h.ledger.has('note_body', 'note-fixed')).toBe(false)
    expect(h.ledger.has('note_body', 'note-still-bad')).toBe(true)
  })

  // #2297 review (A-L2): a failed heal waits out the cooldown again.
  it('refreshes the cooldown of a note body entry whose heal failed', async () => {
    const h = harness({}, {})
    h.ledger.record([{ id: 'note-still-bad', type: 'note_body' }], 'payload')
    h.version.current = '1.1.0'
    const now = vi.spyOn(Date, 'now').mockReturnValue(5_000_000)

    await retrySchemaInvalidItems(h.deps, 'token', new Uint8Array(32))

    expect(h.pullNoteBody).toHaveBeenCalledOnce()
    expect(h.ledger.has('note_body', 'note-still-bad')).toBe(true)
    // Same version, inside the cooldown: not retried.
    await retrySchemaInvalidItems(h.deps, 'token', new Uint8Array(32))
    expect(h.pullNoteBody).toHaveBeenCalledOnce()
    now.mockRestore()
  })

  // #2297 review (B-5): whole-body heals are bounded per pull.
  it('heals at most MAX_NOTE_BODY_HEALS_PER_PULL note bodies per pull', async () => {
    const h = harness({}, {})
    const refs = Array.from({ length: MAX_NOTE_BODY_HEALS_PER_PULL + 5 }, (_, i) => ({
      id: `note-${i}`,
      type: 'note_body'
    }))
    h.ledger.record(refs, 'payload')
    h.version.current = '1.1.0'

    await retrySchemaInvalidItems(h.deps, 'token', new Uint8Array(32))

    expect(h.pullNoteBody).toHaveBeenCalledTimes(MAX_NOTE_BODY_HEALS_PER_PULL)
    expect(refs.filter((ref) => h.ledger.has('note_body', ref.id))).toHaveLength(5)
  })

  // #2297 with #2301: note bodies are healed whole; a pending-intent record of
  // the same note still goes to the /sync/pull re-fetch, without the body ref.
  it('splits note_body heals from the pending_intent re-fetch of the same note', async () => {
    const h = harness({}, {})
    h.ledger.record([{ id: 'note-1', type: 'note' }], 'pending_intent')
    h.ledger.record([{ id: 'note-1', type: 'note_body' }], 'payload')
    h.version.current = '1.1.0'

    await retrySchemaInvalidItems(h.deps, 'token', new Uint8Array(32))

    expect(h.pullNoteBody.mock.calls.map(([noteId]) => noteId)).toEqual(['note-1'])
    expect(h.tracker.refetch).toHaveBeenCalledWith(
      [{ id: 'note-1', type: 'note' }],
      'token',
      expect.any(Uint8Array)
    )
    expect(h.ledger.has('note_body', 'note-1')).toBe(false)
  })
})
