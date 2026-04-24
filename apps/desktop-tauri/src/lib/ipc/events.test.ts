import { describe, it, expect, vi, beforeEach } from 'vitest'

// See src/lib/ipc/invoke.test.ts for rationale — global setup-dom mock must
// step aside so this file can exercise the real events module.
vi.unmock('@/lib/ipc/events')
vi.unmock('./events')

type TauriEventHandler = (event: { payload: unknown }) => void
type UnlistenFn = () => void

let registered: Map<string, TauriEventHandler> | undefined
let unlistenCalls: string[] = []

function mockUnlisten(event: string): UnlistenFn {
  return () => {
    registered?.delete(event)
    unlistenCalls.push(event)
  }
}

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, handler: TauriEventHandler): Promise<UnlistenFn> => {
    registered ??= new Map()
    registered.set(event, handler)
    return mockUnlisten(event)
  })
}))

import { listen, listenOnce } from './events'
import { listen as tauriListen } from '@tauri-apps/api/event'

beforeEach(() => {
  registered = new Map()
  unlistenCalls = []
  vi.clearAllMocks()
})

describe('listen', () => {
  it('delegates to @tauri-apps/api/event.listen and unwraps the payload', async () => {
    const payloads: unknown[] = []
    const unlisten = await listen<string>('test-event', (payload) => {
      payloads.push(payload)
    })
    expect(tauriListen).toHaveBeenCalledWith('test-event', expect.any(Function))
    expect(typeof unlisten).toBe('function')

    const handler = registered!.get('test-event')!
    handler({ payload: 'hello' })
    expect(payloads).toEqual(['hello'])
  })

  it('returns an unlisten fn that removes the listener from Tauri', async () => {
    const unlisten = await listen('ephemeral', () => {})
    expect(registered!.has('ephemeral')).toBe(true)
    unlisten()
    expect(registered!.has('ephemeral')).toBe(false)
    expect(unlistenCalls).toContain('ephemeral')
  })

  it('awaits async callbacks without swallowing errors silently', async () => {
    const seen: string[] = []
    await listen<string>('async-event', async (payload) => {
      await Promise.resolve()
      seen.push(`handled:${payload}`)
    })
    const handler = registered!.get('async-event')!
    handler({ payload: 'x' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(seen).toEqual(['handled:x'])
  })
})

describe('listenOnce', () => {
  it('auto-unsubscribes after the first event fires', async () => {
    const payloads: string[] = []
    await listenOnce<string>('one-shot', (payload) => {
      payloads.push(payload)
    })
    expect(registered!.has('one-shot')).toBe(true)

    const handler = registered!.get('one-shot')!
    handler({ payload: 'first' })

    // The callback is async — yield to let it finish.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(payloads).toEqual(['first'])
    expect(registered!.has('one-shot')).toBe(false)
    expect(unlistenCalls).toContain('one-shot')
  })
})
