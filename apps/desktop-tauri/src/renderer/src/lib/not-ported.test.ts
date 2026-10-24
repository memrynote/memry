import { afterEach, describe, expect, it } from 'vitest'
import { installNotPortedShim, NotPortedError } from './not-ported'

const target = window as unknown as { api?: unknown; electron?: unknown }
const originalApi = target.api
const originalElectron = target.electron

afterEach(() => {
  Object.defineProperty(window, 'api', { value: originalApi, configurable: true, writable: true })
  Object.defineProperty(window, 'electron', {
    value: originalElectron,
    configurable: true,
    writable: true
  })
})

type Shim = Record<string, Record<string, (...args: unknown[]) => unknown>>

describe('installNotPortedShim', () => {
  it('throws NotPortedError naming the call path of a leaf', () => {
    installNotPortedShim()
    const api = window.api as unknown as Shim

    expect(() => api.notes.get('id')).toThrow(NotPortedError)
    expect(() => api.notes.get('id')).toThrow('window.api.notes.get is not ported')
  })

  it('covers window.electron.ipcRenderer.invoke', () => {
    installNotPortedShim()
    const electron = window.electron as unknown as { ipcRenderer: Shim[string] }

    expect(() => electron.ipcRenderer.invoke('x')).toThrow(
      'window.electron.ipcRenderer.invoke is not ported'
    )
  })

  it('returns a no-op unsubscribe for onXxx subscriptions', () => {
    installNotPortedShim()
    const api = window.api as unknown as Shim

    const unsubscribe = api.notes.onChanged(() => {})
    expect(typeof unsubscribe).toBe('function')
    expect(unsubscribe()).toBeUndefined()
  })

  it('is not mistaken for a thenable', async () => {
    installNotPortedShim()

    await expect(Promise.resolve(window.api)).resolves.toBe(window.api)
  })
})
