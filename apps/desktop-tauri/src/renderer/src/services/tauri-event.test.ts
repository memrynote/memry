import { beforeEach, describe, expect, it, vi } from 'vitest'

const logged = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('../lib/logger', () => ({
  createLogger: () => ({ warn: logged.warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

import { subscribeToEvent, subscribeToEvents } from './tauri-event'

function event(listen: () => Promise<() => void>) {
  return { listen: vi.fn(listen) }
}

const live = () => event(async () => () => undefined)
const broken = () => event(() => Promise.reject(new Error('listen refused')))

/** Lets the `listen` promises of the subscriptions settle. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => logged.warn.mockClear())

describe('subscribeToEvents', () => {
  it('reads again once every listener is live', async () => {
    const onListening = vi.fn()
    subscribeToEvents(
      [
        (done) => subscribeToEvent(live(), vi.fn(), done),
        (done) => subscribeToEvent(live(), vi.fn(), done)
      ],
      onListening
    )
    await settled()

    expect(onListening).toHaveBeenCalledTimes(1)
    expect(logged.warn).not.toHaveBeenCalled()
  })

  it('reads again even when one listener fails, and logs the failure for the group', async () => {
    const onListening = vi.fn()
    subscribeToEvents(
      [
        (done) => subscribeToEvent(live(), vi.fn(), done),
        (done) => subscribeToEvent(broken(), vi.fn(), done),
        (done) => subscribeToEvent(live(), vi.fn(), done)
      ],
      onListening
    )
    await settled()

    expect(onListening).toHaveBeenCalledTimes(1)
    expect(logged.warn).toHaveBeenCalledWith('1 of 3 event listeners failed to go live')
  })

  it('does not read again for a group unsubscribed before its listeners settle', async () => {
    const onListening = vi.fn()
    const stop = subscribeToEvents(
      [(done) => subscribeToEvent(broken(), vi.fn(), done)],
      onListening
    )
    stop()
    await settled()

    expect(onListening).not.toHaveBeenCalled()
  })
})
