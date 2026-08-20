import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { loggerMock, runtimeMocks } = vi.hoisted(() => ({
  loggerMock: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  },
  runtimeMocks: {
    createGoogleChannelManager: vi.fn(),
    createGoogleCalendarClient: vi.fn(),
    deleteFromServer: vi.fn(),
    getCalendarSourceById: vi.fn(),
    getValidAccessToken: vi.fn(),
    patchToServer: vi.fn(),
    postToServer: vi.fn(),
    requireDatabase: vi.fn(),
    resolveDefaultGoogleAccountId: vi.fn()
  }
}))

vi.mock('../../../lib/logger', () => ({
  createLogger: () => loggerMock
}))

vi.mock('../../../sync/http-client', () => ({
  deleteFromServer: runtimeMocks.deleteFromServer,
  patchToServer: runtimeMocks.patchToServer,
  postToServer: runtimeMocks.postToServer
}))

vi.mock('../../../sync/token-manager', () => ({
  getValidAccessToken: runtimeMocks.getValidAccessToken
}))

vi.mock('./client', () => ({
  createGoogleCalendarClient: runtimeMocks.createGoogleCalendarClient
}))

vi.mock('./oauth', () => ({
  resolveDefaultGoogleAccountId: runtimeMocks.resolveDefaultGoogleAccountId
}))

vi.mock('../../../database', () => ({
  requireDatabase: runtimeMocks.requireDatabase
}))

vi.mock('./google-channel-manager', () => ({
  createGoogleChannelManager: runtimeMocks.createGoogleChannelManager
}))

vi.mock('../../repositories/calendar-sources-repository', () => ({
  getCalendarSourceById: runtimeMocks.getCalendarSourceById
}))

import {
  __testing_resetGooglePushRuntime,
  createGooglePushRuntime,
  getGooglePushRuntime,
  getOrInitGooglePushRuntime,
  resolvePushAccountIdForSource,
  type CalendarSourceLite
} from './push-runtime'
import type { GoogleChannelManager } from './google-channel-manager'

function buildManagerMock(): GoogleChannelManager & {
  ensureChannelForSource: ReturnType<typeof vi.fn>
  stopForSource: ReturnType<typeof vi.fn>
  stopAll: ReturnType<typeof vi.fn>
  getActiveChannelCount: ReturnType<typeof vi.fn>
} {
  return {
    ensureChannelForSource: vi.fn(async () => {}),
    stopForSource: vi.fn(async () => {}),
    stopAll: vi.fn(async () => {}),
    getActiveChannelCount: vi.fn(() => 0)
  }
}

describe('createGooglePushRuntime (Task 11 — lifecycle wiring)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __testing_resetGooglePushRuntime()
    delete process.env.CALENDAR_PUSH_ENABLED
    delete process.env.MEMRY_WEBHOOK_HMAC_KEY
    delete process.env.MEMRY_CALENDAR_WEBHOOK_URL
    runtimeMocks.requireDatabase.mockReturnValue({ db: true })
    runtimeMocks.getValidAccessToken.mockResolvedValue('token-1')
    runtimeMocks.createGoogleCalendarClient.mockReturnValue({ client: true })
    runtimeMocks.deleteFromServer.mockResolvedValue(undefined)
    runtimeMocks.patchToServer.mockResolvedValue(undefined)
    runtimeMocks.postToServer.mockResolvedValue(undefined)
    runtimeMocks.createGoogleChannelManager.mockImplementation((opts) =>
      Object.assign(buildManagerMock(), { opts })
    )
  })

  afterEach(() => {
    __testing_resetGooglePushRuntime()
    delete process.env.CALENDAR_PUSH_ENABLED
    delete process.env.MEMRY_WEBHOOK_HMAC_KEY
    delete process.env.MEMRY_CALENDAR_WEBHOOK_URL
  })

  describe('ensureForSelectedSources', () => {
    it('registers a channel for each selected non-managed source', async () => {
      // #given
      const manager = buildManagerMock()
      const runtime = createGooglePushRuntime(manager)
      const sources: CalendarSourceLite[] = [
        {
          id: 'google-calendar:work',
          remoteId: 'work@group.calendar.google.com',
          isMemryManaged: false
        },
        { id: 'google-calendar:personal', remoteId: 'me@gmail.com', isMemryManaged: false }
      ]

      // #when
      await runtime.ensureForSelectedSources(sources)

      // #then
      expect(manager.ensureChannelForSource).toHaveBeenCalledTimes(2)
      expect(manager.ensureChannelForSource).toHaveBeenCalledWith({
        sourceId: 'google-calendar:work',
        calendarId: 'work@group.calendar.google.com'
      })
      expect(manager.ensureChannelForSource).toHaveBeenCalledWith({
        sourceId: 'google-calendar:personal',
        calendarId: 'me@gmail.com'
      })
    })

    it('skips memrynote-managed sources (we never webhook our own calendar)', async () => {
      // #given
      const manager = buildManagerMock()
      const runtime = createGooglePushRuntime(manager)
      const sources: CalendarSourceLite[] = [
        { id: 'google-calendar:memry', remoteId: 'memry-managed', isMemryManaged: true },
        { id: 'google-calendar:work', remoteId: 'work', isMemryManaged: false }
      ]

      // #when
      await runtime.ensureForSelectedSources(sources)

      // #then
      expect(manager.ensureChannelForSource).toHaveBeenCalledTimes(1)
      expect(manager.ensureChannelForSource).toHaveBeenCalledWith({
        sourceId: 'google-calendar:work',
        calendarId: 'work'
      })
    })

    it('continues iterating after an ensure failure (no early return)', async () => {
      // #given
      const manager = buildManagerMock()
      manager.ensureChannelForSource
        .mockRejectedValueOnce(new Error('first source failed'))
        .mockResolvedValueOnce(undefined)
      const runtime = createGooglePushRuntime(manager)
      const sources: CalendarSourceLite[] = [
        { id: 'a', remoteId: 'A', isMemryManaged: false },
        { id: 'b', remoteId: 'B', isMemryManaged: false }
      ]

      // #when
      await runtime.ensureForSelectedSources(sources)

      // #then
      expect(manager.ensureChannelForSource).toHaveBeenCalledTimes(2)
      expect(loggerMock.warn).toHaveBeenCalled()
    })
  })

  describe('stopAll', () => {
    it('delegates to manager.stopAll', async () => {
      const manager = buildManagerMock()
      const runtime = createGooglePushRuntime(manager)

      await runtime.stopAll()

      expect(manager.stopAll).toHaveBeenCalledTimes(1)
    })

    it('swallows manager errors so teardown always completes', async () => {
      const manager = buildManagerMock()
      manager.stopAll.mockRejectedValueOnce(new Error('stopAll boom'))
      const runtime = createGooglePushRuntime(manager)

      await expect(runtime.stopAll()).resolves.toBeUndefined()
      expect(loggerMock.warn).toHaveBeenCalled()
    })
  })

  describe('handleSelectionToggle', () => {
    it('#given isSelected=true #when toggled #then ensures a channel for that source', async () => {
      const manager = buildManagerMock()
      const runtime = createGooglePushRuntime(manager)

      await runtime.handleSelectionToggle({
        sourceId: 'src-1',
        isSelected: true,
        calendarId: 'cal-1'
      })

      expect(manager.ensureChannelForSource).toHaveBeenCalledWith({
        sourceId: 'src-1',
        calendarId: 'cal-1'
      })
      expect(manager.stopForSource).not.toHaveBeenCalled()
    })

    it('#given isSelected=false #when toggled #then stops that source', async () => {
      const manager = buildManagerMock()
      const runtime = createGooglePushRuntime(manager)

      await runtime.handleSelectionToggle({
        sourceId: 'src-1',
        isSelected: false,
        calendarId: 'cal-1'
      })

      expect(manager.stopForSource).toHaveBeenCalledWith('src-1')
      expect(manager.ensureChannelForSource).not.toHaveBeenCalled()
    })

    it('swallows selection-toggle manager failures', async () => {
      const manager = buildManagerMock()
      manager.stopForSource.mockRejectedValueOnce(new Error('stop failed'))
      const runtime = createGooglePushRuntime(manager)

      await expect(
        runtime.handleSelectionToggle({
          sourceId: 'src-1',
          isSelected: false,
          calendarId: 'cal-1'
        })
      ).resolves.toBeUndefined()
      expect(loggerMock.warn).toHaveBeenCalledWith(
        'handleSelectionToggle failed',
        expect.objectContaining({ sourceId: 'src-1', isSelected: false })
      )
    })
  })

  describe('getActiveChannelCount', () => {
    it('returns the underlying manager count', () => {
      const manager = buildManagerMock()
      manager.getActiveChannelCount.mockReturnValue(3)
      const runtime = createGooglePushRuntime(manager)

      expect(runtime.getActiveChannelCount()).toBe(3)
    })
  })

  describe('production runtime wiring', () => {
    it('returns null while the push feature flag or HMAC key is missing', () => {
      process.env.CALENDAR_PUSH_ENABLED = '1'

      expect(getOrInitGooglePushRuntime({ onActiveCountChange: vi.fn() })).toBeNull()
      expect(getGooglePushRuntime()).toBeNull()
    })

    it('builds one production runtime with env webhook, server auth, and channel helpers', async () => {
      process.env.CALENDAR_PUSH_ENABLED = '1'
      process.env.MEMRY_WEBHOOK_HMAC_KEY = 'secret-key'
      process.env.MEMRY_CALENDAR_WEBHOOK_URL = ' https://example.test/hook '
      const onActiveCountChange = vi.fn()

      const runtime = getOrInitGooglePushRuntime({ onActiveCountChange })

      expect(runtime).not.toBeNull()
      expect(getOrInitGooglePushRuntime({ onActiveCountChange: vi.fn() })).toBe(runtime)
      expect(getGooglePushRuntime()).toBe(runtime)
      const opts = runtimeMocks.createGoogleChannelManager.mock.calls[0][0]
      expect(opts.webhookUrl).toBe('https://example.test/hook')
      expect(opts.featureEnabled).toBe(true)
      expect(opts.onActiveCountChange).toBe(onActiveCountChange)

      await opts.registerOnServer({ channelId: 'ch-1' })
      await opts.attachResourceId({ channelId: 'ch/1', resourceId: 'res-1' })
      await opts.deleteOnServer({ channelId: 'ch/1' })
      expect(runtimeMocks.postToServer).toHaveBeenCalledWith(
        '/calendar/channels',
        { channelId: 'ch-1' },
        'token-1'
      )
      expect(runtimeMocks.patchToServer).toHaveBeenCalledWith(
        '/calendar/channels/ch%2F1',
        { resourceId: 'res-1' },
        'token-1'
      )
      expect(runtimeMocks.deleteFromServer).toHaveBeenCalledWith(
        '/calendar/channels/ch%2F1',
        'token-1'
      )
      await expect(opts.hashToken('plain-token')).resolves.toHaveLength(64)
      expect(opts.generateToken()).toHaveLength(64)
      expect(opts.generateChannelId()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      )
    })

    it('throws on required server auth but skips best-effort delete without a token', async () => {
      process.env.CALENDAR_PUSH_ENABLED = '1'
      process.env.MEMRY_WEBHOOK_HMAC_KEY = 'secret-key'
      runtimeMocks.getValidAccessToken.mockResolvedValue(null)

      getOrInitGooglePushRuntime({ onActiveCountChange: vi.fn() })
      const opts = runtimeMocks.createGoogleChannelManager.mock.calls[0][0]

      await expect(opts.registerOnServer({})).rejects.toThrow('Not signed in')
      await expect(opts.attachResourceId({ channelId: 'ch', resourceId: 'res' })).rejects.toThrow(
        'Not signed in'
      )
      await expect(opts.deleteOnServer({ channelId: 'ch' })).resolves.toBeUndefined()
      expect(runtimeMocks.deleteFromServer).not.toHaveBeenCalled()
    })

    it('resolves source account from the calendar source, then default account fallback', () => {
      const db = { db: true }
      runtimeMocks.getCalendarSourceById.mockReturnValueOnce({ accountId: 'account-source' })
      expect(resolvePushAccountIdForSource('source-1', db as never)).toBe('account-source')

      runtimeMocks.getCalendarSourceById.mockReturnValueOnce(null)
      runtimeMocks.resolveDefaultGoogleAccountId.mockReturnValueOnce('account-default')
      expect(resolvePushAccountIdForSource('source-2', db as never)).toBe('account-default')

      runtimeMocks.getCalendarSourceById.mockReturnValueOnce(null)
      runtimeMocks.resolveDefaultGoogleAccountId.mockReturnValueOnce(null)
      expect(() => resolvePushAccountIdForSource('source-3', db as never)).toThrow(
        'Cannot resolve Google push account for source source-3'
      )
    })
  })
})
