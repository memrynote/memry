import { describe, expect, it, vi } from 'vitest'
import { retrySchemaInvalidItems, type ItemRecoveryDeps } from './item-recovery'
import { SchemaInvalidLedger } from './schema-invalid-ledger'
import type { CorruptItemTracker, RecoveredItem, RefetchResult } from './corrupt-item-tracker'
import type { SyncContext } from './sync-context'
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
      ...refetch
    })),
    markFailed: vi.fn()
  }
  const onChanged = vi.fn()
  const deps: ItemRecoveryDeps = {
    ctx: { applier: { apply }, deps: { emitToRenderer: vi.fn() } } as unknown as SyncContext,
    tracker: tracker as unknown as CorruptItemTracker,
    ledger,
    onChanged
  }
  return { deps, ledger, tracker, version, applied, onChanged }
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

  it('does not call the server when nothing is retryable', async () => {
    const h = harness({}, {})
    h.ledger.record([{ id: 'task-1', type: 'task' }], 'payload')

    await retrySchemaInvalidItems(h.deps, 'token', new Uint8Array(32))

    expect(h.tracker.refetch).not.toHaveBeenCalled()
  })
})
