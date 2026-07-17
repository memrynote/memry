import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { InboxSettings } from './inbox-section'

const updateSettings = vi.fn().mockResolvedValue(true)
vi.mock('@/hooks/use-inbox-preferences', () => ({
  useInboxPreferences: () => ({
    settings: { reviewReminderEnabled: true, reviewReminderTime: '18:00' },
    isLoading: false,
    error: null,
    updateSettings
  })
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: { clockFormat: '24h' } })
}))

describe('InboxSettings section', () => {
  it('renders the review-reminder controls', () => {
    render(<InboxSettings />)
    expect(screen.getByTestId('inbox-review-toggle')).toBeInTheDocument()
    // 24h: an hour + minute field, no AM/PM toggle. Value 18:00 → hour 18, minute 00.
    expect(screen.getByTestId('inbox-review-time-hour')).toHaveValue('18')
    expect(screen.getByTestId('inbox-review-time-minute')).toHaveValue('00')
    expect(screen.queryByTestId('inbox-review-time-period')).not.toBeInTheDocument()
  })

  it('persists a time change on blur', () => {
    render(<InboxSettings />)
    const hour = screen.getByTestId('inbox-review-time-hour')
    const minute = screen.getByTestId('inbox-review-time-minute')
    fireEvent.change(hour, { target: { value: '06' } })
    fireEvent.change(minute, { target: { value: '30' } })
    fireEvent.blur(minute)
    expect(updateSettings).toHaveBeenCalledWith({ reviewReminderTime: '06:30' })
  })
})
