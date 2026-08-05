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

  it('does not tombstone a row shouldSkip rejects', () => {
    const queue = { enqueue: vi.fn() }

    const controller = new RecordSyncController({
      type: 'task',
      queue,
      getDeviceId: () => 'device-A',
      load: () => ({ id: 'task-1', title: 'Hello', localOnly: true }),
      applyLocalChange: ({ local }) => local,
      serialize: (local) => local,
      shouldSkip: (local) => Boolean(local.localOnly),
      buildDeletePayload: () => JSON.stringify({ tombstone: true })
    })

    controller.enqueueDelete('task-1')

    expect(queue.enqueue).not.toHaveBeenCalled()
  })

  it('still tombstones an already-removed row, whose local-only-ness is unknowable', () => {
    // Deliberate asymmetry: with the row gone there is nothing left to read the
    // flag off, and refusing to enqueue would silently swallow legitimate
    // deletes for ordinary rows. `shouldSkip` here would reject everything —
    // it simply never gets a row to reject.
    const queue = { enqueue: vi.fn() }
    const buildDeletePayload = vi.fn(() => JSON.stringify({ tombstone: true }))

    const controller = new RecordSyncController<{ id: string; localOnly?: boolean }, [], []>({
      type: 'task',
      queue,
      getDeviceId: () => 'device-A',
      load: () => undefined,
      applyLocalChange: ({ local }) => local,
      serialize: (local) => local,
      shouldSkip: () => true,
      buildDeletePayload
    })

    controller.enqueueDelete('task-1')

    expect(buildDeletePayload).toHaveBeenCalledWith(expect.objectContaining({ local: undefined }))
    expect(queue.enqueue).toHaveBeenCalledTimes(1)
  })
})

describe('withIncrementedClock', () => {
  it('adds a device tick to serialized payload clocks', () => {
    expect(withIncrementedClock(JSON.stringify({ title: 'Hello' }), 'device-A')).toBe(
      JSON.stringify({ title: 'Hello', clock: { 'device-A': 1 } })
    )
  })
})
