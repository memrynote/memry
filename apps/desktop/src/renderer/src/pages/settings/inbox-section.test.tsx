import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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

const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a)
  }
}))

const sendTestInboxReviewNotification = vi.fn().mockResolvedValue({ supported: true })

describe('InboxSettings section', () => {
  beforeEach(() => {
    toastSuccess.mockClear()
    toastError.mockClear()
    sendTestInboxReviewNotification.mockClear().mockResolvedValue({ supported: true })
    window.api = { settings: { sendTestInboxReviewNotification } } as never
  })

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

  it('fires a test notification and confirms delivery on click', async () => {
    render(<InboxSettings />)
    fireEvent.click(screen.getByTestId('inbox-review-test'))
    expect(sendTestInboxReviewNotification).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1))
    expect(toastError).not.toHaveBeenCalled()
  })

  it('warns when the OS cannot show desktop notifications', async () => {
    sendTestInboxReviewNotification.mockResolvedValueOnce({ supported: false })
    render(<InboxSettings />)
    fireEvent.click(screen.getByTestId('inbox-review-test'))
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
    expect(toastSuccess).not.toHaveBeenCalled()
  })
})
