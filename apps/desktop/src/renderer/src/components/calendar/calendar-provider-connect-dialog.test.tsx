import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders, userEvent } from '@tests/utils/render'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'

const { mockConnectCalendarProvider } = vi.hoisted(() => ({
  mockConnectCalendarProvider: vi.fn()
}))

vi.mock('@/services/calendar-service', () => ({
  GOOGLE_CALENDAR_PROVIDER_ID: 'google',
  connectCalendarProvider: mockConnectCalendarProvider
}))

import { CalendarProviderConnectDialog } from './calendar-provider-connect-dialog'

let i18nEn: I18nInstance

function renderDialog(props: Partial<{ providerId: string; authFlow: 'oauth2' | 'url' }> = {}) {
  return renderWithProviders(
    <I18nextProvider i18n={i18nEn}>
      <CalendarProviderConnectDialog open onOpenChange={vi.fn()} {...props} />
    </I18nextProvider>
  )
}

describe('CalendarProviderConnectDialog (#1395)', () => {
  beforeAll(async () => {
    i18nEn = await createRendererI18n({ locale: 'en' })
  })

  beforeEach(() => {
    mockConnectCalendarProvider.mockReset()
    mockConnectCalendarProvider.mockResolvedValue({ success: true })
  })

  it('defaults to google when no provider is given', async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(await screen.findByRole('button', { name: /continue/i }))

    expect(mockConnectCalendarProvider).toHaveBeenCalledWith('google')
  })

  it('connects the provider it was handed, not google', async () => {
    const user = userEvent.setup()
    renderDialog({ providerId: 'ics', authFlow: 'url' })

    await user.click(await screen.findByRole('button', { name: /continue/i }))

    expect(mockConnectCalendarProvider).toHaveBeenCalledWith('ics')
  })

  it('surfaces a failed connect instead of closing silently', async () => {
    const user = userEvent.setup()
    mockConnectCalendarProvider.mockResolvedValue({ success: false, error: 'provider said no' })

    renderDialog()
    await user.click(await screen.findByRole('button', { name: /continue/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('provider said no')
  })
})
