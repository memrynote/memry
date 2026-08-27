import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The offline matrix's network lever.
 *
 * Worth a test because the whole point of it is a NEGATIVE guarantee: it must
 * be inert in a release build. A switch that survived into a shipped app would
 * be an app that can be put offline and left there, which is a support ticket
 * nobody could diagnose.
 *
 * The marker file is mocked, so this asserts the semantics rather than
 * expo-file-system's behaviour.
 */

const state = { exists: false, writes: 0, deletes: 0 }

vi.mock('expo-file-system', () => ({
  Paths: { document: '/documents' },
  File: class {
    constructor(..._args: unknown[]) {}
    get exists(): boolean {
      return state.exists
    }
    write(): void {
      state.writes += 1
      state.exists = true
    }
    delete(): void {
      state.deletes += 1
      state.exists = false
    }
  }
}))

async function load() {
  vi.resetModules()
  return import('../dev-network')
}

describe('dev network switch', () => {
  beforeEach(() => {
    state.exists = false
    state.writes = 0
    state.deletes = 0
    vi.stubGlobal('__DEV__', true)
  })

  it('is off with no marker', async () => {
    const { isDevOffline } = await load()
    expect(isDevOffline()).toBe(false)
  })

  it('reads a marker written by something else', async () => {
    // This is how the driver flips it: straight into the app's document
    // directory, with no scheme, no UI and no running app required — the case
    // a deep link could not cover, because the dev-client shell swallows it.
    state.exists = true
    const { isDevOffline } = await load()
    expect(isDevOffline()).toBe(true)
  })

  it('picks up an external write once the read cache expires', async () => {
    vi.useFakeTimers()
    try {
      const { isDevOffline } = await load()
      expect(isDevOffline()).toBe(false)

      state.exists = true
      // Still cached: the check runs per request, so it is deliberately not a
      // stat every time.
      expect(isDevOffline()).toBe(false)

      vi.advanceTimersByTime(300)
      expect(isDevOffline()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('writes and clears the marker', async () => {
    const { isDevOffline, setDevOffline } = await load()
    setDevOffline(true)
    expect(state.writes).toBe(1)
    expect(isDevOffline()).toBe(true)

    setDevOffline(false)
    expect(state.deletes).toBe(1)
    expect(isDevOffline()).toBe(false)
  })

  it('notifies subscribers when the state changes', async () => {
    const { setDevOffline, subscribeDevOffline } = await load()
    const seen: boolean[] = []
    subscribeDevOffline((offline) => seen.push(offline))

    setDevOffline(true)
    setDevOffline(false)
    expect(seen).toEqual([true, false])
  })

  it('is INERT outside a dev build, even with a marker present', async () => {
    vi.stubGlobal('__DEV__', false)
    state.exists = true
    const { isDevOffline, setDevOffline } = await load()

    // The negative guarantee: no reachable switch in a shipped app.
    expect(isDevOffline()).toBe(false)
    setDevOffline(true)
    expect(state.writes).toBe(0)
    expect(isDevOffline()).toBe(false)
  })
})
