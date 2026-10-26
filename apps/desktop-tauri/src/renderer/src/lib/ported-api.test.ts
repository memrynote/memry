import { describe, expect, it } from 'vitest'
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

  it('defines window.api when nothing was installed before', () => {
    const host: PortedApiHost = {}
    installPortedApi(host)
    expect(typeof (host.api as Record<string, unknown>).locale).toBe('object')
  })
})
