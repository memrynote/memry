import { describe, expect, it, vi } from 'vitest'
import type { VectorClock } from '@memry/contracts/sync-api'
import { RecordSyncController, withIncrementedClock } from './record-sync'

describe('RecordSyncController', () => {
  it('increments local clocks and enqueues serialized record mutations', () => {
    const queue = { enqueue: vi.fn() }
    const state = new Map<string, { id: string; clock?: VectorClock; title: string }>([
      ['task-1', { id: 'task-1', title: 'Hello' }]
    ])

    const controller = new RecordSyncController({
      type: 'task',
      queue,
      getDeviceId: () => 'device-A',
      load: (itemId) => state.get(itemId),
      applyLocalChange: ({ itemId, local, deviceId }) => {
        const next = {
          ...local,
          clock: { ...(local.clock ?? {}), [deviceId]: ((local.clock ?? {})[deviceId] ?? 0) + 1 }
        }
        state.set(itemId, next)
        return next
      },
      serialize: (local) => local
    })

    controller.enqueueUpdate('task-1')

    expect(queue.enqueue).toHaveBeenCalledWith({
      type: 'task',
      itemId: 'task-1',
      operation: 'update',
      payload: JSON.stringify({
        id: 'task-1',
        title: 'Hello',
        clock: { 'device-A': 1 }
      }),
      priority: 0
    })
  })

  it('tracks missing-device changes without enqueueing when an offline handler exists', () => {
    const queue = { enqueue: vi.fn() }
    const handleMissingDevice = vi.fn()

    const controller = new RecordSyncController({
      type: 'task',
      queue,
      getDeviceId: () => null,
      load: () => ({ id: 'task-1', title: 'Hello' }),
      applyLocalChange: ({ local }) => local,
      serialize: (local) => local,
      handleMissingDevice
    })

    controller.enqueueUpdate('task-1', ['statusId'])

    expect(handleMissingDevice).toHaveBeenCalledWith('task-1', 'update', [['statusId']])
    expect(queue.enqueue).not.toHaveBeenCalled()
  })
})

describe('withIncrementedClock', () => {
  it('adds a device tick to serialized payload clocks', () => {
    expect(withIncrementedClock(JSON.stringify({ title: 'Hello' }), 'device-A')).toBe(
      JSON.stringify({ title: 'Hello', clock: { 'device-A': 1 } })
    )
  })
})
