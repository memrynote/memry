import { beforeEach, describe, expect, it, vi } from 'vitest'

import { trackTelemetry } from './telemetry'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

interface TrackedEventShape {
  id: string
  name: string
  occurredAt: string
  surface: string
  action: string
  result?: string
  errorCode?: string
  source?: string
  objectType?: string
  metrics?: Record<string, number>
  dimensions?: Record<string, string>
}

describe('trackTelemetry (renderer wrapper)', () => {
  beforeEach(() => {
    const apiMock = window.api as unknown as { telemetry?: { track: ReturnType<typeof vi.fn> } }
    apiMock.telemetry = {
      track: vi.fn().mockResolvedValue({ success: true })
    }
  })

  it('forwards a minimal event with an auto-generated UUID and ISO timestamp', async () => {
    // #given the renderer wrapper
    const trackFn = window.api.telemetry!.track as ReturnType<typeof vi.fn>

    // #when tracking a known event with safe enums
    await trackTelemetry('app_started', { surface: 'app', action: 'started' })

    // #then a single event was forwarded with safe shape
    expect(trackFn).toHaveBeenCalledTimes(1)
    const event = trackFn.mock.calls[0][0] as TrackedEventShape
    expect(event.name).toBe('app_started')
    expect(event.surface).toBe('app')
    expect(event.action).toBe('started')
    expect(event.id).toMatch(UUID_PATTERN)
    expect(event.occurredAt).toMatch(ISO_PATTERN)
  })

  it('passes optional safe fields through to the main process', async () => {
    const trackFn = window.api.telemetry!.track as ReturnType<typeof vi.fn>

    await trackTelemetry('inbox_filed', {
      surface: 'inbox',
      action: 'filed',
      objectType: 'note',
      source: 'sidebar',
      result: 'success',
      metrics: { durationMs: 12 },
      dimensions: { capture_type: 'text' }
    })

    const event = trackFn.mock.calls[0][0] as TrackedEventShape
    expect(event.objectType).toBe('note')
    expect(event.source).toBe('sidebar')
    expect(event.result).toBe('success')
    expect(event.metrics).toEqual({ durationMs: 12 })
    expect(event.dimensions).toEqual({ capture_type: 'text' })
  })

  it('does not throw if the main-process IPC rejects', async () => {
    const trackFn = window.api.telemetry!.track as ReturnType<typeof vi.fn>
    trackFn.mockRejectedValueOnce(new Error('ipc unavailable'))

    await expect(
      trackTelemetry('app_started', { surface: 'app', action: 'started' })
    ).resolves.toBeUndefined()
  })

  it('does not throw if window.api.telemetry is missing', async () => {
    delete (window.api as unknown as { telemetry?: unknown }).telemetry

    await expect(
      trackTelemetry('app_started', { surface: 'app', action: 'started' })
    ).resolves.toBeUndefined()
  })

  it('drops dimension values that look like emails, urls, or paths', async () => {
    const trackFn = window.api.telemetry!.track as ReturnType<typeof vi.fn>

    await trackTelemetry('search_performed', {
      surface: 'search',
      action: 'queried',
      dimensions: {
        format: 'markdown',
        leak: 'alice@example.com',
        leakUrl: 'https://example.com/x',
        leakPath: '/Users/me/docs'
      }
    })

    const event = trackFn.mock.calls[0][0] as TrackedEventShape
    expect(event.dimensions).toEqual({ format: 'markdown' })
  })

  it('drops a dimension key that is not on the allowlist, however safe it looks', async () => {
    const trackFn = window.api.telemetry!.track as ReturnType<typeof vi.fn>

    // Scraped page metadata clears every safe-value rule — short, no @, no ://,
    // no slash — so only a closed key namespace can keep it off the wire (#1142).
    await trackTelemetry('inbox_captured', {
      surface: 'inbox',
      action: 'captured',
      dimensions: { page_title: 'Divorce settlement calculator' }
    })

    const event = trackFn.mock.calls[0][0] as TrackedEventShape
    expect(event.dimensions).toBeUndefined()
  })

  it('drops unsafe dimension keys and UUID-shaped values', async () => {
    const trackFn = window.api.telemetry!.track as ReturnType<typeof vi.fn>

    await trackTelemetry('search_performed', {
      surface: 'search',
      action: 'queried',
      dimensions: {
        result_bucket: 'six_plus',
        '/Users/me/Documents': 'safe_value',
        account_id: '550e8400-e29b-41d4-a716-446655440000'
      }
    })

    const event = trackFn.mock.calls[0][0] as TrackedEventShape
    expect(event.dimensions).toEqual({ result_bucket: 'six_plus' })
  })
})
