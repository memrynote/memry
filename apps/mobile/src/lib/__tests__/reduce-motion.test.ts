import { describe, expect, it, vi } from 'vitest'

import { watchReduceMotion, type ReduceMotionSource } from '../reduce-motion'

/**
 * "Reduce motion" as a live value (#2114).
 *
 * The regression these guard against is the obvious implementation: `await
 * AccessibilityInfo.isReduceMotionEnabled()` once in an effect and stop. That
 * leaves the guest animating for the rest of the session after the reader turns
 * motion off, and it sets state on a screen that has already been popped.
 */
function source(initial: boolean): {
  source: ReduceMotionSource
  settle: () => Promise<void>
  emit: (enabled: boolean) => void
  unsubscribed: () => number
} {
  const listeners: ((enabled: boolean) => void)[] = []
  let unsubscribes = 0
  let resolveRead: (enabled: boolean) => void = () => {}
  const read = new Promise<boolean>((resolve) => {
    resolveRead = resolve
  })
  return {
    source: {
      read: () => read,
      subscribe: (listener) => {
        listeners.push(listener)
        return () => {
          unsubscribes += 1
        }
      }
    },
    settle: async () => {
      resolveRead(initial)
      await read
      await Promise.resolve()
    },
    emit: (enabled) => listeners.forEach((listener) => listener(enabled)),
    unsubscribed: () => unsubscribes
  }
}

describe('watchReduceMotion', () => {
  it('delivers the value the async read settles on', async () => {
    const onChange = vi.fn()
    const rig = source(true)
    watchReduceMotion(rig.source, onChange)

    expect(onChange).not.toHaveBeenCalled()
    await rig.settle()

    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('delivers later changes, so a mid-session toggle reaches the guest', async () => {
    const onChange = vi.fn()
    const rig = source(false)
    watchReduceMotion(rig.source, onChange)
    await rig.settle()
    onChange.mockClear()

    rig.emit(true)
    rig.emit(false)

    expect(onChange.mock.calls).toEqual([[true], [false]])
  })

  it('unsubscribes and stops delivering once disposed', async () => {
    const onChange = vi.fn()
    const rig = source(false)
    const dispose = watchReduceMotion(rig.source, onChange)
    await rig.settle()
    onChange.mockClear()

    dispose()
    rig.emit(true)

    expect(rig.unsubscribed()).toBe(1)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('drops a read that settles after dispose', async () => {
    const onChange = vi.fn()
    const rig = source(true)
    const dispose = watchReduceMotion(rig.source, onChange)

    dispose()
    await rig.settle()

    expect(onChange).not.toHaveBeenCalled()
  })

  it('survives a source that cannot answer', async () => {
    const onChange = vi.fn()
    const listeners: ((enabled: boolean) => void)[] = []
    watchReduceMotion(
      {
        read: () => Promise.reject(new Error('no accessibility service')),
        subscribe: (next) => {
          listeners.push(next)
          return () => {}
        }
      },
      onChange
    )
    await Promise.resolve()
    await Promise.resolve()

    expect(onChange).not.toHaveBeenCalled()
    listeners.forEach((listener) => listener(true))
    expect(onChange).toHaveBeenCalledWith(true)
  })
})
