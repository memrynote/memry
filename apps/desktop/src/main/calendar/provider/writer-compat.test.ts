import { describe, expect, it, vi } from 'vitest'
import { CALENDAR_MULTI_WRITER_MIN_APP_VERSION } from '@memry/contracts/calendar-api'
import { PROVIDER_CAPABILITIES } from './capabilities'
import {
  checkProviderWriterCompat,
  isAppVersionBelow,
  providerNeedsWriterCompatCheck,
  writerCompatAllowsConnect,
  type RemoteDeviceForCompat,
  type WriterCompatDeps
} from './writer-compat'

function deps(
  devices: RemoteDeviceForCompat[] | null | Error,
  overrides: Partial<WriterCompatDeps> = {}
): WriterCompatDeps {
  return {
    isSignedIn: vi.fn(async () => true),
    listDevices: vi.fn(async () => {
      if (devices instanceof Error) throw devices
      return devices
    }),
    currentDeviceId: () => 'this-mac',
    ...overrides
  }
}

describe('mitigation (b): version floor before a second writable provider connects (#1396)', () => {
  it('orders release versions numerically, like the sync server', () => {
    expect(isAppVersionBelow('2026.919.1', '2026.925.0')).toBe(true)
    expect(isAppVersionBelow('2026.1002.1', '2026.925.0')).toBe(false)
    expect(isAppVersionBelow('2026.925.0', '2026.925.0')).toBe(false)
    expect(isAppVersionBelow('1.0.0', CALENDAR_MULTI_WRITER_MIN_APP_VERSION)).toBe(true)
    expect(isAppVersionBelow('garbage', CALENDAR_MULTI_WRITER_MIN_APP_VERSION)).toBe(true)
  })

  it('only checks providers that add a second writer', () => {
    expect(providerNeedsWriterCompatCheck('google')).toBe(false)
    expect(providerNeedsWriterCompatCheck('ics')).toBe(false)
    expect(providerNeedsWriterCompatCheck('unknown')).toBe(false)
    // Any non-Google provider that can write needs the check.
    for (const [id, capabilities] of Object.entries(PROVIDER_CAPABILITIES)) {
      expect(providerNeedsWriterCompatCheck(id)).toBe(id !== 'google' && capabilities.supportsWrite)
    }
  })

  describe('for a writable non-Google provider', () => {
    const provider = 'writable-test'

    function withWritable<T>(run: () => Promise<T>): Promise<T> {
      const table = PROVIDER_CAPABILITIES as Record<string, (typeof PROVIDER_CAPABILITIES)[string]>
      table[provider] = { ...PROVIDER_CAPABILITIES.ics, supportsWrite: true, authFlow: 'basic' }
      return run().finally(() => {
        delete table[provider]
      })
    }

    it('lists other devices below the floor, and devices with no version, but never this one', () =>
      withWritable(async () => {
        const result = await checkProviderWriterCompat(
          provider,
          deps([
            { id: 'this-mac', name: 'This Mac', platform: 'macos', appVersion: '1.0.0' },
            { id: 'old-pc', name: 'Old PC', platform: 'windows', appVersion: '2026.919.1' },
            { id: 'new-pc', name: 'New PC', platform: 'windows', appVersion: '2026.1002.1' },
            { id: 'mystery', name: 'Unknown', platform: 'linux', appVersion: null }
          ])
        )
        expect(result).toEqual({
          required: true,
          verified: true,
          minVersion: CALENDAR_MULTI_WRITER_MIN_APP_VERSION,
          outdatedDevices: [
            { id: 'old-pc', name: 'Old PC', platform: 'windows', appVersion: '2026.919.1' },
            { id: 'mystery', name: 'Unknown', platform: 'linux', appVersion: null }
          ]
        })
        expect(writerCompatAllowsConnect(result, undefined)).toBe(false)
        expect(writerCompatAllowsConnect(result, true)).toBe(true)
      }))

    it('lets the connect through when every other device is current', () =>
      withWritable(async () => {
        const result = await checkProviderWriterCompat(
          provider,
          deps([{ id: 'new-pc', name: 'New PC', platform: 'windows', appVersion: '2026.1002.1' }])
        )
        expect(result.outdatedDevices).toEqual([])
        expect(writerCompatAllowsConnect(result, undefined)).toBe(true)
      }))

    it('skips phones and web clients: they never write to an external calendar', () =>
      withWritable(async () => {
        const result = await checkProviderWriterCompat(
          provider,
          deps([
            { id: 'phone', name: 'iPhone', platform: 'ios', appVersion: '0.1.0' },
            { id: 'tablet', name: 'Tablet', platform: 'android', appVersion: null },
            { id: 'old-pc', name: 'Old PC', platform: 'windows', appVersion: '2026.919.1' }
          ])
        )
        expect(result.outdatedDevices.map((device) => device.id)).toEqual(['old-pc'])
      }))

    it('asks for an acknowledgement when the device list cannot be read', () =>
      withWritable(async () => {
        const result = await checkProviderWriterCompat(provider, deps(new Error('offline')))
        expect(result).toMatchObject({ required: true, verified: false, outdatedDevices: [] })
        expect(writerCompatAllowsConnect(result, undefined)).toBe(false)
        expect(writerCompatAllowsConnect(result, true)).toBe(true)
      }))

    it('needs nothing without a Memry account: no other device can receive the rows', () =>
      withWritable(async () => {
        const listDevices = vi.fn()
        const result = await checkProviderWriterCompat(
          provider,
          deps([], { isSignedIn: async () => false, listDevices })
        )
        expect(listDevices).not.toHaveBeenCalled()
        expect(writerCompatAllowsConnect(result, undefined)).toBe(true)
      }))
  })
})
