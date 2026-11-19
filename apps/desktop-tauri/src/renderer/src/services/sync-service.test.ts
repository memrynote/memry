import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Payload = {
  operation: 'pull'
  items: Array<{ itemId: string; type: string; itemOperation: 'create' | 'update' | 'delete' }>
}

const channel = vi.hoisted(() => ({
  handlers: [] as Array<(received: { payload: Payload }) => void>,
  /** Holds every `listen` answer until released, as main does before the listener is live. */
  answer: null as Promise<void> | null
}))

vi.mock('../../../generated/bindings', () => ({
  events: {
    syncItemSyncedEvent: {
      listen: async (handler: (received: { payload: Payload }) => void) => {
        await channel.answer
        channel.handlers.push(handler)
        return () => {
          channel.handlers = channel.handlers.filter((h) => h !== handler)
        }
      }
    }
  }
}))

import { onSyncedRecords } from './sync-service'

const page = (...items: Payload['items']) => {
  for (const handler of channel.handlers) handler({ payload: { operation: 'pull', items } })
}
const task = (itemId: string, itemOperation: 'create' | 'update' | 'delete' = 'update') => ({
  itemId,
  type: 'task',
  itemOperation
})

beforeEach(() => {
  channel.handlers = []
  channel.answer = null
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('onSyncedRecords', () => {
  it('coalesces three pages within 150 ms into one call per subscriber', async () => {
    const tasks = vi.fn()
    const projects = vi.fn()
    onSyncedRecords(['task'], tasks)
    onSyncedRecords(['project'], projects)
    await vi.advanceTimersByTimeAsync(0)

    page(task('t1'), { itemId: 'p1', type: 'project', itemOperation: 'create' })
    await vi.advanceTimersByTimeAsync(50)
    page(task('t2'))
    await vi.advanceTimersByTimeAsync(50)
    page(task('t3'))
    await vi.advanceTimersByTimeAsync(49)
    expect(tasks).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(tasks).toHaveBeenCalledTimes(1)
    expect(tasks).toHaveBeenCalledWith([task('t1'), task('t2'), task('t3')])
    expect(projects).toHaveBeenCalledTimes(1)
    expect(projects).toHaveBeenCalledWith([
      { itemId: 'p1', type: 'project', itemOperation: 'create' }
    ])
  })

  it('tells a record once, with its last operation', async () => {
    const callback = vi.fn()
    onSyncedRecords(['task'], callback)
    await vi.advanceTimersByTimeAsync(0)

    page(task('t1', 'create'), task('t2'))
    page(task('t1', 'delete'))
    await vi.advanceTimersByTimeAsync(150)

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith([task('t2'), task('t1', 'delete')])
  })

  it('stays quiet for pages of other types, and hears every type when asked for all', async () => {
    const tasks = vi.fn()
    const all = vi.fn()
    onSyncedRecords(['task'], tasks)
    onSyncedRecords('all', all)
    await vi.advanceTimersByTimeAsync(0)

    page({ itemId: 'i1', type: 'inbox', itemOperation: 'create' })
    await vi.advanceTimersByTimeAsync(150)

    expect(tasks).not.toHaveBeenCalled()
    expect(all).toHaveBeenCalledWith([{ itemId: 'i1', type: 'inbox', itemOperation: 'create' }])
  })

  it('drops a pending call when the subscriber leaves', async () => {
    const callback = vi.fn()
    const stop = onSyncedRecords(['task'], callback)
    await vi.advanceTimersByTimeAsync(0)

    page(task('t1'))
    stop()
    await vi.advanceTimersByTimeAsync(150)

    expect(callback).not.toHaveBeenCalled()
  })

  // Tauri's `listen` goes live only when main answers it, and a page main sends before then
  // reaches nobody: the subscriber cannot tell which records it missed, so its owner reads again.
  it('tells the subscriber once the listener is live, so a page sent before then is read again', async () => {
    let release = (): void => undefined
    channel.answer = new Promise<void>((resolve) => {
      release = resolve
    })
    const callback = vi.fn()
    const onListening = vi.fn()
    onSyncedRecords(['task'], callback, onListening)

    page(task('t1'))
    await vi.advanceTimersByTimeAsync(150)
    expect(callback).not.toHaveBeenCalled()
    expect(onListening).not.toHaveBeenCalled()

    release()
    await vi.advanceTimersByTimeAsync(0)

    expect(onListening).toHaveBeenCalledTimes(1)
    expect(callback).not.toHaveBeenCalled()
  })
})
