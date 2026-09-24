import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentAccessConsent } from './use-agent-access-consent'

describe('useAgentAccessConsent (#1394)', () => {
  let releaseGoogle: (value: { agentReadEventsConsent: null }) => void = () => {}
  const getCalendarGoogleSettings = vi.fn()
  const getCalendarProviderSettings = vi.fn()
  const setCalendarGoogleSettings = vi.fn(async () => ({ success: true }))
  const setCalendarProviderSettings = vi.fn(async () => ({ success: true }))

  beforeEach(() => {
    getCalendarGoogleSettings.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseGoogle = resolve
        })
    )
    getCalendarProviderSettings.mockResolvedValue({ agentReadEventsConsent: null })
    window.api = {
      ...window.api,
      settings: {
        ...window.api?.settings,
        getCalendarGoogleSettings,
        getCalendarProviderSettings,
        setCalendarGoogleSettings,
        setCalendarProviderSettings
      }
    } as typeof window.api
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('a provider list that changes mid-read still asks about every provider', async () => {
    const { result, rerender } = renderHook(
      ({ providers }: { providers: string[] }) => useAgentAccessConsent(providers),
      { initialProps: { providers: ['google', 'ics'] } }
    )
    // A sources refetch adds CalDAV while Google's answer is still loading.
    rerender({ providers: ['google', 'ics', 'caldav'] })
    await act(async () => {
      releaseGoogle({ agentReadEventsConsent: null })
    })

    await waitFor(() => expect(getCalendarProviderSettings).toHaveBeenCalledTimes(2))
    const asked: string[] = []
    for (let step = 0; step < 3; step += 1) {
      await waitFor(() => expect(result.current.promptProvider).not.toBeNull())
      asked.push(result.current.promptProvider as string)
      await act(async () => {
        await result.current.decide(false)
      })
    }
    expect(asked.sort()).toEqual(['caldav', 'google', 'ics'])
    expect(result.current.promptProvider).toBeNull()
  })
})
