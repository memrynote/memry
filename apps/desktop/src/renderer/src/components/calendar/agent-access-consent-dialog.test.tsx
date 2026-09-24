import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AgentAccessConsentDialog } from './agent-access-consent-dialog'

describe('AgentAccessConsentDialog per provider (#1394)', () => {
  let consent: Record<string, boolean | null>
  const setGoogle = vi.fn()
  const setProvider = vi.fn()

  beforeEach(() => {
    consent = { google: null, ics: null }
    setGoogle.mockReset().mockResolvedValue({ success: true })
    setProvider.mockReset().mockResolvedValue({ success: true })
    window.api = {
      ...window.api,
      settings: {
        ...window.api.settings,
        getCalendarGoogleSettings: vi.fn(async () => ({
          defaultTargetCalendarId: null,
          onboardingCompleted: true,
          promoteConfirmDismissed: false,
          pushEventsToGoogle: true,
          agentReadEventsConsent: consent.google
        })),
        setCalendarGoogleSettings: setGoogle,
        getCalendarProviderSettings: vi.fn(async ({ provider }: { provider: string }) =>
          provider in consent ? { agentReadEventsConsent: consent[provider] } : null
        ),
        setCalendarProviderSettings: setProvider
      }
    }
  })

  it('asks an ICS-only install about its subscribed calendars', async () => {
    render(<AgentAccessConsentDialog providerIds={['ics']} />)

    const dialog = await screen.findByTestId('agent-access-consent-dialog')
    expect(dialog).toHaveAttribute('data-provider', 'ics')
    expect(screen.getByText('Let AI read your subscribed calendar events?')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    await waitFor(() =>
      expect(setProvider).toHaveBeenCalledWith({
        provider: 'ics',
        updates: { agentReadEventsConsent: true }
      })
    )
    expect(setGoogle).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByTestId('agent-access-consent-dialog')).toBeNull())
  })

  it('keeps Google’s original prompt and settings channel', async () => {
    render(<AgentAccessConsentDialog providerIds={['google']} />)

    expect(await screen.findByText('Let AI read your Google Calendar events?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: "Don't allow" }))
    await waitFor(() => expect(setGoogle).toHaveBeenCalledWith({ agentReadEventsConsent: false }))
    expect(setProvider).not.toHaveBeenCalled()
  })

  it('asks each provider in turn, and a Google yes does not answer for ICS', async () => {
    consent.google = true
    render(<AgentAccessConsentDialog providerIds={['google', 'ics']} />)

    const dialog = await screen.findByTestId('agent-access-consent-dialog')
    expect(dialog).toHaveAttribute('data-provider', 'ics')
  })

  it('stays closed once every provider has an answer, and for providers this build does not know', async () => {
    consent = { google: false, ics: true }
    render(<AgentAccessConsentDialog providerIds={['google', 'ics', 'microsoft']} />)

    await waitFor(() => expect(window.api.settings.getCalendarProviderSettings).toHaveBeenCalled())
    expect(screen.queryByTestId('agent-access-consent-dialog')).toBeNull()
  })
})
