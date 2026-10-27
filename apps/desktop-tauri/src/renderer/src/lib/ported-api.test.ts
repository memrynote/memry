import { describe, expect, it } from 'vitest'
import { installNotPortedShim } from './not-ported'
import { installPortedApi, type PortedApiHost } from './ported-api'

describe('installPortedApi', () => {
  it('serves the ported domains and falls through to the layer below for the rest', () => {
    const host: PortedApiHost = { api: { notes: { get: 'shim' }, settings: 'shim' } }

    installPortedApi(host)

    const api = host.api as Record<string, unknown>
    expect(api.notes).toEqual({ get: 'shim' })
    expect(api.settings).not.toBe('shim')
    expect(typeof api.onSettingsChanged).toBe('function')
  })

  it('answers a settings name the port lacks from the shim, as a rejection and never a throw', async () => {
    const host: PortedApiHost = {}
    installNotPortedShim(host)
    installPortedApi(host)
    const api = host.api as { settings: Record<string, () => Promise<unknown>> }

    expect(typeof api.settings.getGeneralSettings).toBe('function')
    let pending: Promise<unknown> | undefined
    expect(() => {
      pending = api.settings.registerGlobalCapture()
    }).not.toThrow()
    await expect(pending).rejects.toMatchObject({
      name: 'NotPortedError'
    })
  })

  it('defines window.api when nothing was installed before', () => {
    const host: PortedApiHost = {}
    installPortedApi(host)
    expect(typeof (host.api as Record<string, unknown>).locale).toBe('object')
  })
})
