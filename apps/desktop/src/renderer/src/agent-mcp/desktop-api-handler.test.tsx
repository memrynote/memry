import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMcpDesktopApiChannel } from '@memry/contracts/agent-mcp-channels'

const mocks = vi.hoisted(() => ({
  logError: vi.fn(),
  logWarn: vi.fn()
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: mocks.logError,
    warn: mocks.logWarn
  })
}))

import { useAgentMcpDesktopApiResponder } from './desktop-api-handler'

describe('useAgentMcpDesktopApiResponder', () => {
  let onMainInvokeCallback:
    | ((payload: { requestId: string; channel: string; payload?: unknown }) => void | Promise<void>)
    | undefined
  let respondToMainInvoke: ReturnType<typeof vi.fn>
  let templatesList: ReturnType<typeof vi.fn>
  let templatesCreate: ReturnType<typeof vi.fn>
  let calendarGetProviderStatus: ReturnType<typeof vi.fn>
  let calendarGetRange: ReturnType<typeof vi.fn>
  let calendarListEvents: ReturnType<typeof vi.fn>
  let getCalendarGoogleSettings: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onMainInvokeCallback = undefined
    respondToMainInvoke = vi.fn()
    templatesList = vi.fn().mockResolvedValue({ templates: [] })
    templatesCreate = vi.fn().mockResolvedValue({
      success: true,
      template: { id: 'template-1', name: 'Template' }
    })
    calendarGetProviderStatus = vi.fn().mockResolvedValue({ connected: true })
    calendarGetRange = vi.fn().mockResolvedValue({ items: [] })
    calendarListEvents = vi.fn().mockResolvedValue({ events: [] })
    // null = the user has not answered the agent-access prompt yet. Until they
    // grant it, Google-synced events stay out of every agent read.
    getCalendarGoogleSettings = vi.fn().mockResolvedValue({ agentReadEventsConsent: null })
    mocks.logError.mockReset()
    ;(window as Window & { api: unknown }).api = {
      onMainInvoke: vi.fn(
        (
          callback: (payload: {
            requestId: string
            channel: string
            payload?: unknown
          }) => void | Promise<void>
        ) => {
          onMainInvokeCallback = callback
          return vi.fn()
        }
      ),
      respondToMainInvoke,
      templates: {
        list: templatesList,
        create: templatesCreate
      },
      calendar: {
        getProviderStatus: calendarGetProviderStatus,
        getRange: calendarGetRange,
        listEvents: calendarListEvents
      },
      settings: {
        getCalendarGoogleSettings
      }
    }
  })

  it('forwards allowlisted desktop read operations to window.api', async () => {
    renderHook(() => useAgentMcpDesktopApiResponder())
    await waitFor(() => expect(window.api.onMainInvoke).toHaveBeenCalled())

    await onMainInvokeCallback?.({
      requestId: 'request-1',
      channel: AgentMcpDesktopApiChannel,
      payload: { operation: 'templates.list', args: [] }
    })

    expect(templatesList).toHaveBeenCalledWith()
    expect(respondToMainInvoke).toHaveBeenCalledWith('request-1', {
      ok: true,
      data: { templates: [] }
    })
  })

  it('does not subscribe when disabled', () => {
    renderHook(() => useAgentMcpDesktopApiResponder({ enabled: false }))

    expect(window.api.onMainInvoke).not.toHaveBeenCalled()
  })

  it('forwards allowlisted desktop write operations with args', async () => {
    renderHook(() => useAgentMcpDesktopApiResponder())
    await waitFor(() => expect(window.api.onMainInvoke).toHaveBeenCalled())

    await onMainInvokeCallback?.({
      requestId: 'request-2',
      channel: AgentMcpDesktopApiChannel,
      payload: { operation: 'templates.create', args: [{ name: 'Template' }] }
    })

    expect(templatesCreate).toHaveBeenCalledWith({ name: 'Template' })
    expect(respondToMainInvoke).toHaveBeenCalledWith('request-2', {
      ok: true,
      data: {
        success: true,
        template: { id: 'template-1', name: 'Template' }
      }
    })
  })

  it('rejects Google Calendar integration operations', async () => {
    renderHook(() => useAgentMcpDesktopApiResponder())
    await waitFor(() => expect(window.api.onMainInvoke).toHaveBeenCalled())

    const operations = [
      'calendar.getProviderStatus',
      'calendar.listSources',
      'calendar.listGoogleCalendars',
      'calendar.promoteExternalEvent',
      'settings.getCalendarGoogleSettings'
    ]

    for (const operation of operations) {
      await onMainInvokeCallback?.({
        requestId: `request-${operation}`,
        channel: AgentMcpDesktopApiChannel,
        payload: { operation, args: [{}] }
      })

      expect(respondToMainInvoke).toHaveBeenCalledWith(`request-${operation}`, {
        ok: false,
        error: { code: 'VALIDATION', message: 'Invalid desktop API request.' }
      })
    }

    expect(calendarGetProviderStatus).not.toHaveBeenCalled()
  })

  it('normalizes positional date args for calendar range reads', async () => {
    renderHook(() => useAgentMcpDesktopApiResponder())
    await waitFor(() => expect(window.api.onMainInvoke).toHaveBeenCalled())

    await onMainInvokeCallback?.({
      requestId: 'request-calendar-range-positional',
      channel: AgentMcpDesktopApiChannel,
      payload: { operation: 'calendar.getRange', args: ['2026-05-14', '2026-06-14'] }
    })

    expect(calendarGetRange).toHaveBeenCalledWith({
      startAt: localDayIso('2026-05-14'),
      endAt: localDayIso('2026-06-15'),
      includeExternal: false
    })
  })

  it('normalizes stringified calendar range objects', async () => {
    renderHook(() => useAgentMcpDesktopApiResponder())
    await waitFor(() => expect(window.api.onMainInvoke).toHaveBeenCalled())

    await onMainInvokeCallback?.({
      requestId: 'request-calendar-range-string',
      channel: AgentMcpDesktopApiChannel,
      payload: {
        operation: 'calendar.getRange',
        args: ['{"start":"2026-05-14","end":"2026-06-14"}']
      }
    })

    expect(calendarGetRange).toHaveBeenCalledWith({
      startAt: localDayIso('2026-05-14'),
      endAt: localDayIso('2026-06-15'),
      includeExternal: false
    })
  })

  async function invokeCalendarRange(requestId: string): Promise<void> {
    await onMainInvokeCallback?.({
      requestId,
      channel: AgentMcpDesktopApiChannel,
      payload: {
        operation: 'calendar.getRange',
        args: [
          {
            startAt: '2026-05-14T09:00:00.000Z',
            endAt: '2026-05-14T10:00:00.000Z',
            includeUnselectedSources: true,
            includeExternal: true
          }
        ]
      }
    })
  }

  it('keeps Google events out of range reads while consent is unanswered', async () => {
    renderHook(() => useAgentMcpDesktopApiResponder())
    await waitFor(() => expect(window.api.onMainInvoke).toHaveBeenCalled())

    await invokeCalendarRange('request-calendar-range-unanswered')

    expect(calendarGetRange).toHaveBeenCalledWith({
      startAt: '2026-05-14T09:00:00.000Z',
      endAt: '2026-05-14T10:00:00.000Z',
      includeExternal: false
    })
  })

  it('keeps Google events out of range reads when consent is denied, ignoring caller flags', async () => {
    getCalendarGoogleSettings.mockResolvedValue({ agentReadEventsConsent: false })
    renderHook(() => useAgentMcpDesktopApiResponder())
    await waitFor(() => expect(window.api.onMainInvoke).toHaveBeenCalled())

    await invokeCalendarRange('request-calendar-range-denied')

    expect(calendarGetRange).toHaveBeenCalledWith({
      startAt: '2026-05-14T09:00:00.000Z',
      endAt: '2026-05-14T10:00:00.000Z',
      includeExternal: false
    })
  })

  it('includes Google events in range reads once the user grants consent', async () => {
    getCalendarGoogleSettings.mockResolvedValue({ agentReadEventsConsent: true })
    renderHook(() => useAgentMcpDesktopApiResponder())
    await waitFor(() => expect(window.api.onMainInvoke).toHaveBeenCalled())

    await invokeCalendarRange('request-calendar-range-granted')

    expect(calendarGetRange).toHaveBeenCalledWith({
      startAt: '2026-05-14T09:00:00.000Z',
      endAt: '2026-05-14T10:00:00.000Z',
      includeExternal: true
    })
  })

  it('falls back to excluding Google events when the consent lookup fails', async () => {
    getCalendarGoogleSettings.mockRejectedValue(new Error('settings unavailable'))
    renderHook(() => useAgentMcpDesktopApiResponder())
    await waitFor(() => expect(window.api.onMainInvoke).toHaveBeenCalled())

    await invokeCalendarRange('request-calendar-range-settings-error')

    expect(calendarGetRange).toHaveBeenCalledWith({
      startAt: '2026-05-14T09:00:00.000Z',
      endAt: '2026-05-14T10:00:00.000Z',
      includeExternal: false
    })
  })

  it('parses stringified empty args for calendar event lists', async () => {
    renderHook(() => useAgentMcpDesktopApiResponder())
    await waitFor(() => expect(window.api.onMainInvoke).toHaveBeenCalled())

    await onMainInvokeCallback?.({
      requestId: 'request-calendar-list-string',
      channel: AgentMcpDesktopApiChannel,
      payload: { operation: 'calendar.listEvents', args: ['{}'] }
    })

    expect(calendarListEvents).toHaveBeenCalledWith({})
  })

  it('preserves calendar event list filters', async () => {
    renderHook(() => useAgentMcpDesktopApiResponder())
    await waitFor(() => expect(window.api.onMainInvoke).toHaveBeenCalled())

    await onMainInvokeCallback?.({
      requestId: 'request-calendar-list-filtered',
      channel: AgentMcpDesktopApiChannel,
      payload: { operation: 'calendar.listEvents', args: [{ includeArchived: true }] }
    })

    expect(calendarListEvents).toHaveBeenCalledWith({ includeArchived: true })
  })

  it('falls back to empty calendar event list args for malformed string args', async () => {
    renderHook(() => useAgentMcpDesktopApiResponder())
    await waitFor(() => expect(window.api.onMainInvoke).toHaveBeenCalled())

    await onMainInvokeCallback?.({
      requestId: 'request-calendar-list-malformed',
      channel: AgentMcpDesktopApiChannel,
      payload: { operation: 'calendar.listEvents', args: ['not-json'] }
    })

    expect(calendarListEvents).toHaveBeenCalledWith({})
  })

  it('rejects operations outside the desktop CRUD allowlist', async () => {
    renderHook(() => useAgentMcpDesktopApiResponder())
    await waitFor(() => expect(window.api.onMainInvoke).toHaveBeenCalled())

    await onMainInvokeCallback?.({
      requestId: 'request-3',
      channel: AgentMcpDesktopApiChannel,
      payload: { operation: 'account.signOut', args: [] }
    })

    expect(respondToMainInvoke).toHaveBeenCalledWith('request-3', {
      ok: false,
      error: { code: 'VALIDATION', message: 'Invalid desktop API request.' }
    })
  })

  it('ignores unrelated main invoke channels', async () => {
    renderHook(() => useAgentMcpDesktopApiResponder())
    await waitFor(() => expect(window.api.onMainInvoke).toHaveBeenCalled())

    await onMainInvokeCallback?.({
      requestId: 'request-ignore',
      channel: 'other-channel',
      payload: { operation: 'templates.list', args: [] }
    })

    expect(templatesList).not.toHaveBeenCalled()
    expect(respondToMainInvoke).not.toHaveBeenCalled()
  })

  it('returns a desktop API error when an allowlisted operation is unavailable', async () => {
    renderHook(() => useAgentMcpDesktopApiResponder())
    await waitFor(() => expect(window.api.onMainInvoke).toHaveBeenCalled())

    await onMainInvokeCallback?.({
      requestId: 'request-4',
      channel: AgentMcpDesktopApiChannel,
      payload: { operation: 'bookmarks.list', args: [] }
    })

    expect(respondToMainInvoke).toHaveBeenCalledWith('request-4', {
      ok: false,
      error: {
        code: 'DESKTOP_API_ERROR',
        message: 'Desktop API operation is unavailable: bookmarks.list'
      }
    })
    expect(mocks.logError).toHaveBeenCalled()
  })

  it('returns a desktop API error when an allowlisted operation is not callable', async () => {
    ;(window.api.templates as Record<string, unknown>).list = []

    renderHook(() => useAgentMcpDesktopApiResponder())
    await waitFor(() => expect(window.api.onMainInvoke).toHaveBeenCalled())

    await onMainInvokeCallback?.({
      requestId: 'request-5',
      channel: AgentMcpDesktopApiChannel,
      payload: { operation: 'templates.list', args: [] }
    })

    expect(respondToMainInvoke).toHaveBeenCalledWith('request-5', {
      ok: false,
      error: {
        code: 'DESKTOP_API_ERROR',
        message: 'Desktop API operation is not callable: templates.list'
      }
    })
    expect(mocks.logError).toHaveBeenCalled()
  })
})

function localDayIso(value: string): string {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day, 0, 0, 0, 0).toISOString()
}
