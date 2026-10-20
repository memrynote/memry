import { describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { createLogger: () => logger }
})

vi.mock('../../telemetry/diagnostics', () => ({ trackMainLog: vi.fn() }))

import { reportConflict } from './conflict-report'

describe('reportConflict', () => {
  /**
   * The load-bearing half of convergence after a field merge (#2180). A merged
   * row carries the UNION clock, which no other device and not the server has
   * seen; if nothing re-queued it, the merged value would never leave the
   * device and two devices that merged the same concurrent pair would sit on
   * different values with identical clocks.
   */
  it('re-queues the merged item so the union-clocked row reaches the server', () => {
    const enqueue = vi.fn()

    reportConflict(
      { queue: { enqueue } },
      { id: 'task-1', type: 'task', clock: { deviceX: 1, deviceY: 2 } }
    )

    expect(enqueue).toHaveBeenCalledWith({
      type: 'task',
      itemId: 'task-1',
      operation: 'update',
      // Rebuilt from the live row at dequeue (push-coordinator.resolvePushPayload),
      // so the placeholder is never what goes over the wire.
      payload: '{}'
    })
  })
})
