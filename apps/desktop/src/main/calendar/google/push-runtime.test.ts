import { describe, expect, it, vi } from 'vitest'

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

import { createGooglePushRuntime, type CalendarSourceLite } from './push-runtime'
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

    it('skips Memry-managed sources (we never webhook our own calendar)', async () => {
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
  })

  describe('getActiveChannelCount', () => {
    it('returns the underlying manager count', () => {
      const manager = buildManagerMock()
      manager.getActiveChannelCount.mockReturnValue(3)
      const runtime = createGooglePushRuntime(manager)

      expect(runtime.getActiveChannelCount()).toBe(3)
    })
  })
})
