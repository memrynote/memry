import { describe, expect, it } from 'vitest'

import { TelemetryChannels } from '../../contracts/src/ipc-channels.ts'
import { telemetryRpc } from './telemetry.ts'

describe('telemetryRpc domain shape', () => {
  it('has name "telemetry"', () => {
    expect(telemetryRpc.name).toBe('telemetry')
  })

  it('exposes track, flush, getSettings, setEnabled methods', () => {
    expect(telemetryRpc.methods.track.channel).toBe(TelemetryChannels.invoke.TRACK)
    expect(telemetryRpc.methods.flush.channel).toBe(TelemetryChannels.invoke.FLUSH)
    expect(telemetryRpc.methods.getSettings.channel).toBe(TelemetryChannels.invoke.GET_SETTINGS)
    expect(telemetryRpc.methods.setEnabled.channel).toBe(TelemetryChannels.invoke.SET_ENABLED)
  })

  it('every method spec carries a channel, mode, and arg arrays', () => {
    for (const [key, method] of Object.entries(telemetryRpc.methods)) {
      expect(method.channel, `method ${key}`).toBeTypeOf('string')
      expect(method.channel.length, `method ${key} channel`).toBeGreaterThan(0)
      expect(['invoke', 'sync'], `method ${key} mode`).toContain(method.mode)
      expect(Array.isArray(method.params)).toBe(true)
      expect(Array.isArray(method.invokeArgs)).toBe(true)
    }
  })

  it('method channels are unique', () => {
    const channels = Object.values(telemetryRpc.methods).map((m) => m.channel)
    expect(new Set(channels).size).toBe(channels.length)
  })

  it('track method declares its event param', () => {
    expect(telemetryRpc.methods.track.params).toEqual(['event'])
  })

  it('setEnabled method declares its enabled param', () => {
    expect(telemetryRpc.methods.setEnabled.params).toEqual(['enabled'])
  })
})
