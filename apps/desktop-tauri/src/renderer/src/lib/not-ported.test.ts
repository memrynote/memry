import { describe, expect, it } from 'vitest'
import { installNotPortedShim, NotPortedError, type NotPortedHost } from './not-ported'

type Shim = Record<string, Record<string, (...args: unknown[]) => unknown>>

// `tests/setup-dom.ts` defines window.api as non-configurable, so the shim goes onto a stand-in.
function install(): { api: Shim; electron: Shim } {
  const target: NotPortedHost = {}
  installNotPortedShim(target)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the shim answers every path
  return target as { api: Shim; electron: Shim }
}

describe('installNotPortedShim', () => {
  it('throws NotPortedError naming the call path of a leaf', () => {
    const { api } = install()

    expect(() => api.notes.get('id')).toThrow(NotPortedError)
    expect(() => api.notes.get('id')).toThrow('window.api.notes.get is not ported')
  })

  it('covers window.electron.ipcRenderer.invoke', () => {
    const { electron } = install()

    expect(() => electron.ipcRenderer.invoke('x')).toThrow(
      'window.electron.ipcRenderer.invoke is not ported'
    )
  })

  it('returns a no-op unsubscribe for onXxx subscriptions', () => {
    const { api } = install()

    const unsubscribe = api.notes.onChanged(() => undefined)
    expect(typeof unsubscribe).toBe('function')
    expect(typeof unsubscribe === 'function' && unsubscribe()).toBeUndefined()
  })

  it('is not mistaken for a thenable', async () => {
    const { api } = install()

    await expect(Promise.resolve(api)).resolves.toBe(api)
  })
})
