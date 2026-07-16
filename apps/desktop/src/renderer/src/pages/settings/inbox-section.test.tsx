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

describe('InboxSettings section', () => {
  it('renders the review-reminder controls', () => {
    render(<InboxSettings />)
    expect(screen.getByTestId('inbox-review-toggle')).toBeInTheDocument()
    expect(screen.getByTestId('inbox-review-time')).toHaveValue('18:00')
  })

  it('persists a time change', () => {
    render(<InboxSettings />)
    fireEvent.change(screen.getByTestId('inbox-review-time'), { target: { value: '06:30' } })
    expect(updateSettings).toHaveBeenCalledWith({ reviewReminderTime: '06:30' })
  })
})
