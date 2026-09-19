import { describe, expect, it, vi } from 'vitest'
import { EVENT_CHANNELS } from '@memry/contracts/ipc-events'

vi.mock('../../lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { createLogger: () => logger }
})

vi.mock('../../telemetry/diagnostics', () => ({ trackMainLog: vi.fn() }))

vi.mock('../item-handlers', () => ({ getRemoteSyncAdapter: vi.fn() }))

import { reportConflictAndRequeue } from './conflict-report'

describe('reportConflictAndRequeue', () => {
  /**
   * The load-bearing half of convergence after a field merge (#2180). A merged
   * row carries the UNION clock, which no other device and not the server has
   * seen; if nothing re-queued it, the merged value would never leave the
   * device and two devices that merged the same concurrent pair would sit on
   * different values with identical clocks.
   */
  it('re-queues the merged item so the union-clocked row reaches the server', () => {
    const enqueue = vi.fn()

    reportConflictAndRequeue({
      dec: {
        id: 'task-1',
        type: 'task',
        content: JSON.stringify({ title: 'remote' }),
        clock: { deviceX: 1, deviceY: 2 }
      },
      emitToRenderer: vi.fn(),
      queue: { enqueue },
      localVersion: { title: 'local', clock: { deviceX: 2, deviceY: 1 } }
    })

    expect(enqueue).toHaveBeenCalledWith({
      type: 'task',
      itemId: 'task-1',
      operation: 'update',
      // Rebuilt from the live row at dequeue (push-coordinator.resolvePushPayload),
      // so the placeholder is never what goes over the wire.
      payload: '{}'
    })
  })

  it('emits both versions with their clocks to the renderer', () => {
    const emitToRenderer = vi.fn()

    reportConflictAndRequeue({
      dec: {
        id: 'task-1',
        type: 'task',
        content: JSON.stringify({ title: 'remote' }),
        clock: { deviceY: 2 }
      },
      emitToRenderer,
      queue: { enqueue: vi.fn() },
      localVersion: { title: 'local', clock: { deviceX: 2 } }
    })

    expect(emitToRenderer).toHaveBeenCalledWith(
      EVENT_CHANNELS.CONFLICT_DETECTED,
      expect.objectContaining({
        itemId: 'task-1',
        type: 'task',
        localClock: { deviceX: 2 },
        remoteClock: { deviceY: 2 }
      })
    )
  })

  it('still re-queues when the remote content does not parse', () => {
    const enqueue = vi.fn()

    reportConflictAndRequeue({
      dec: { id: 'task-1', type: 'task', content: 'not json', clock: { deviceY: 2 } },
      emitToRenderer: vi.fn(),
      queue: { enqueue },
      localVersion: {}
    })

    expect(enqueue).toHaveBeenCalledTimes(1)
  })
})
