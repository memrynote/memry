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
  it('rejects with NotPortedError naming the call path of a leaf, and never throws', async () => {
    const { api } = install()

    const pending = api.notes.get('id')
    await expect(pending).rejects.toBeInstanceOf(NotPortedError)
    await expect(api.notes.get('id')).rejects.toThrow('window.api.notes.get is not ported')
  })

  it('keeps `fn.call(thisArg)` on the same leaf, so a caller that uses it is not crashed', async () => {
    const { api } = install()

    await expect(api.settings.getKeyboardSettings.bind(api.settings)()).rejects.toThrow(
      'window.api.settings.getKeyboardSettings is not ported'
    )
  })

  it('covers window.electron.ipcRenderer.invoke', async () => {
    const { electron } = install()

    await expect(electron.ipcRenderer.invoke('x')).rejects.toThrow(
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
