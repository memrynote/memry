import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}))

vi.mock('../../lib/logger', () => ({
  createLogger: () => loggerMock
}))

import { createGoogleChannelManager, type GoogleChannelManagerDeps } from './google-channel-manager'

interface HarnessDeps extends GoogleChannelManagerDeps {
  // Spies on deps for assertions
  client: {
    watchCalendar: ReturnType<typeof vi.fn>
    stopChannel: ReturnType<typeof vi.fn>
  }
  registerOnServer: ReturnType<typeof vi.fn>
  attachResourceId: ReturnType<typeof vi.fn>
  deleteOnServer: ReturnType<typeof vi.fn>
}

const TTL_SECONDS = 7 * 24 * 60 * 60 // 7 days
const MARGIN_SECONDS = 60 * 60 // 1 hour
const FIXED_NOW_MS = 1_700_000_000_000

function buildDeps(overrides: Partial<GoogleChannelManagerDeps> = {}): HarnessDeps {
  let channelCounter = 0
  let tokenCounter = 0
  return {
    client: {
      watchCalendar: vi.fn(async (input) => ({
        resourceId: `resource-${input.channelId}`,
        expiration: FIXED_NOW_MS + TTL_SECONDS * 1000
      })),
      stopChannel: vi.fn(async () => {})
    },
    registerOnServer: vi.fn(async () => {}),
    attachResourceId: vi.fn(async () => {}),
    deleteOnServer: vi.fn(async () => {}),
    hashToken: vi.fn(async (plaintext: string) =>
      createHash('sha256').update(plaintext).digest('hex')
    ),
    generateToken: vi.fn(() => `token-${++tokenCounter}`),
    generateChannelId: vi.fn(() => `channel-${++channelCounter}`),
    webhookUrl: 'https://sync.memry.io/webhooks/google-calendar',
    ttlSeconds: TTL_SECONDS,
    rotationMarginSeconds: MARGIN_SECONDS,
    featureEnabled: true,
    now: () => Date.now(),
    ...overrides
  } as HarnessDeps
}

describe('google-channel-manager', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_NOW_MS)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  describe('ensureChannelForSource', () => {
    it('registers hash on sync-server, watches Google, then PATCHes resourceId', async () => {
      const deps = buildDeps()
      const mgr = createGoogleChannelManager(deps)

      await mgr.ensureChannelForSource({ sourceId: 'src-1', calendarId: 'cal@group.google.com' })

      expect(deps.registerOnServer).toHaveBeenCalledTimes(1)
      const registerArg = deps.registerOnServer.mock.calls[0]![0] as {
        channelId: string
        sourceId: string
        tokenHash: string
        expiresAt: number
      }
      expect(registerArg.channelId).toBe('channel-1')
      expect(registerArg.sourceId).toBe('src-1')
      expect(registerArg.tokenHash).toBe(createHash('sha256').update('token-1').digest('hex'))
      expect(registerArg.tokenHash).toMatch(/^[0-9a-f]{64}$/)
      expect(registerArg.expiresAt).toBe(Math.floor(FIXED_NOW_MS / 1000) + TTL_SECONDS)

      expect(deps.client.watchCalendar).toHaveBeenCalledTimes(1)
      const watchArg = deps.client.watchCalendar.mock.calls[0]![0] as {
        calendarId: string
        channelId: string
        token: string
        webhookUrl: string
        ttlSeconds: number
      }
      expect(watchArg).toEqual({
        calendarId: 'cal@group.google.com',
        channelId: 'channel-1',
        token: 'token-1',
        webhookUrl: 'https://sync.memry.io/webhooks/google-calendar',
        ttlSeconds: TTL_SECONDS
      })

      expect(deps.attachResourceId).toHaveBeenCalledWith({
        channelId: 'channel-1',
        resourceId: 'resource-channel-1'
      })

      expect(mgr.getActiveChannelCount()).toBe(1)
    })

    it('no-ops when featureEnabled is false', async () => {
      const deps = buildDeps({ featureEnabled: false })
      const mgr = createGoogleChannelManager(deps)

      await mgr.ensureChannelForSource({ sourceId: 'src-1', calendarId: 'cal-a' })

      expect(deps.registerOnServer).not.toHaveBeenCalled()
      expect(deps.client.watchCalendar).not.toHaveBeenCalled()
      expect(mgr.getActiveChannelCount()).toBe(0)
    })

    it('dedupes: second call for same sourceId is a no-op', async () => {
      const deps = buildDeps()
      const mgr = createGoogleChannelManager(deps)

      await mgr.ensureChannelForSource({ sourceId: 'src-1', calendarId: 'cal-a' })
      await mgr.ensureChannelForSource({ sourceId: 'src-1', calendarId: 'cal-a' })

      expect(deps.client.watchCalendar).toHaveBeenCalledTimes(1)
      expect(mgr.getActiveChannelCount()).toBe(1)
    })

    it('fires onActiveCountChange when transitioning 0 → 1', async () => {
      const onActiveCountChange = vi.fn()
      const deps = buildDeps({ onActiveCountChange })
      const mgr = createGoogleChannelManager(deps)

      await mgr.ensureChannelForSource({ sourceId: 'src-1', calendarId: 'cal-a' })

      expect(onActiveCountChange).toHaveBeenCalledWith(1)
    })

    it('resolves a client per source and reuses that client for stop operations', async () => {
      const clientA = {
        watchCalendar: vi.fn(async (input: { channelId: string }) => ({
          resourceId: `resource-${input.channelId}`,
          expiration: FIXED_NOW_MS + TTL_SECONDS * 1000
        })),
        stopChannel: vi.fn(async () => {})
      }
      const clientB = {
        watchCalendar: vi.fn(async (input: { channelId: string }) => ({
          resourceId: `resource-${input.channelId}`,
          expiration: FIXED_NOW_MS + TTL_SECONDS * 1000
        })),
        stopChannel: vi.fn(async () => {})
      }
      const resolveClient = vi.fn(
        ({ sourceId }: { sourceId: string }) => (sourceId === 'src-1' ? clientA : clientB)
      )
      const deps = buildDeps({ resolveClient })
      const mgr = createGoogleChannelManager(deps)

      await mgr.ensureChannelForSource({ sourceId: 'src-1', calendarId: 'cal-a' })
      await mgr.ensureChannelForSource({ sourceId: 'src-2', calendarId: 'cal-b' })
      await mgr.stopForSource('src-2')

      expect(resolveClient).toHaveBeenCalledWith({ sourceId: 'src-1', calendarId: 'cal-a' })
      expect(resolveClient).toHaveBeenCalledWith({ sourceId: 'src-2', calendarId: 'cal-b' })
      expect(clientA.watchCalendar).toHaveBeenCalledTimes(1)
      expect(clientB.watchCalendar).toHaveBeenCalledTimes(1)
      expect(clientB.stopChannel).toHaveBeenCalledWith({
        channelId: 'channel-2',
        resourceId: 'resource-channel-2'
      })
      expect(deps.client.watchCalendar).not.toHaveBeenCalled()
    })
  })

  describe('stopForSource', () => {
    it('stops the channel on Google, deletes on server, clears state', async () => {
      const deps = buildDeps()
      const mgr = createGoogleChannelManager(deps)

      await mgr.ensureChannelForSource({ sourceId: 'src-1', calendarId: 'cal-a' })
      await mgr.stopForSource('src-1')

      expect(deps.client.stopChannel).toHaveBeenCalledWith({
        channelId: 'channel-1',
        resourceId: 'resource-channel-1'
      })
      expect(deps.deleteOnServer).toHaveBeenCalledWith({ channelId: 'channel-1' })
      expect(mgr.getActiveChannelCount()).toBe(0)
    })

    it('is a no-op for unknown sourceId', async () => {
      const deps = buildDeps()
      const mgr = createGoogleChannelManager(deps)

      await mgr.stopForSource('never-registered')

      expect(deps.client.stopChannel).not.toHaveBeenCalled()
      expect(deps.deleteOnServer).not.toHaveBeenCalled()
    })

    it('fires onActiveCountChange on 1 → 0 transition', async () => {
      const onActiveCountChange = vi.fn()
      const deps = buildDeps({ onActiveCountChange })
      const mgr = createGoogleChannelManager(deps)

      await mgr.ensureChannelForSource({ sourceId: 'src-1', calendarId: 'cal-a' })
      onActiveCountChange.mockClear()

      await mgr.stopForSource('src-1')

      expect(onActiveCountChange).toHaveBeenCalledWith(0)
    })
  })

  describe('stopAll', () => {
    it('stops every registered channel', async () => {
      const deps = buildDeps()
      const mgr = createGoogleChannelManager(deps)

      await mgr.ensureChannelForSource({ sourceId: 'src-1', calendarId: 'cal-a' })
      await mgr.ensureChannelForSource({ sourceId: 'src-2', calendarId: 'cal-b' })
      expect(mgr.getActiveChannelCount()).toBe(2)

      await mgr.stopAll()

      expect(deps.client.stopChannel).toHaveBeenCalledTimes(2)
      expect(deps.deleteOnServer).toHaveBeenCalledTimes(2)
      expect(mgr.getActiveChannelCount()).toBe(0)
    })
  })

  describe('rotation', () => {
    it('rotates the channel before ttl expiry (using ttl - margin as trigger)', async () => {
      const deps = buildDeps()
      const mgr = createGoogleChannelManager(deps)

      await mgr.ensureChannelForSource({ sourceId: 'src-1', calendarId: 'cal-a' })

      expect(deps.client.watchCalendar).toHaveBeenCalledTimes(1)
      expect(deps.client.stopChannel).not.toHaveBeenCalled()

      // Advance to just before the rotation trigger — nothing happens yet.
      const rotationDelayMs = (TTL_SECONDS - MARGIN_SECONDS) * 1000
      await vi.advanceTimersByTimeAsync(rotationDelayMs - 10)
      expect(deps.client.stopChannel).not.toHaveBeenCalled()

      // Cross the trigger — old channel is stopped, a new one is created.
      await vi.advanceTimersByTimeAsync(20)

      expect(deps.client.stopChannel).toHaveBeenCalledTimes(1)
      expect(deps.client.stopChannel).toHaveBeenCalledWith({
        channelId: 'channel-1',
        resourceId: 'resource-channel-1'
      })
      expect(deps.client.watchCalendar).toHaveBeenCalledTimes(2)
      const secondWatch = deps.client.watchCalendar.mock.calls[1]![0] as { channelId: string }
      expect(secondWatch.channelId).toBe('channel-2')
      expect(mgr.getActiveChannelCount()).toBe(1)
    })
  })

  describe('security', () => {
    it('never stores the plaintext token anywhere retrievable after registration', async () => {
      const deps = buildDeps()
      const mgr = createGoogleChannelManager(deps)

      await mgr.ensureChannelForSource({ sourceId: 'src-1', calendarId: 'cal-a' })

      // Whole manager surface must not leak token-1. getActiveChannelCount exposes only a number.
      expect(JSON.stringify({ count: mgr.getActiveChannelCount() })).not.toContain('token-1')
      // sync-server received the hash, not the plaintext.
      const registerArg = deps.registerOnServer.mock.calls[0]![0] as { tokenHash: string }
      expect(registerArg.tokenHash).not.toContain('token-1')
      expect(registerArg.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    })
  })
})
