import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { GoogleCalendarOnboardingDialog } from './google-calendar-onboarding-dialog'
import type { ListGoogleCalendarsResponse } from '@memry/contracts/calendar-api'

const listGoogleCalendars = vi.fn<() => Promise<ListGoogleCalendarsResponse>>()
const setDefaultGoogleCalendar = vi.fn<
  (input: { calendarId: string | null; markOnboardingComplete?: boolean }) => Promise<{
    success: boolean
    error?: string
  }>
>()

vi.mock('@/services/calendar-service', () => ({
  listGoogleCalendars: (...args: unknown[]) => listGoogleCalendars(...(args as [])),
  setDefaultGoogleCalendar: (input: {
    calendarId: string | null
    markOnboardingComplete?: boolean
  }) => setDefaultGoogleCalendar(input)
}))

const CALENDARS: ListGoogleCalendarsResponse = {
  calendars: [
    {
      id: 'primary@example.com',
      title: 'user@example.com',
      timezone: 'UTC',
      color: '#1a73e8',
      isPrimary: true
    },
    {
      id: 'work@group.calendar.google.com',
      title: 'Work',
      timezone: 'UTC',
      color: '#0b8043',
      isPrimary: false
    }
  ],
  primary: {
    id: 'primary@example.com',
    title: 'user@example.com',
    timezone: 'UTC',
    color: '#1a73e8',
    isPrimary: true
  },
  currentDefaultId: null
}

function renderDialog(
  overrides: {
    open?: boolean
    onOpenChange?: (open: boolean) => void
    onCompleted?: () => void | Promise<void>
  } = {}
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } }
  })
  const onOpenChange = overrides.onOpenChange ?? vi.fn()
  const onCompleted = overrides.onCompleted ?? vi.fn()
  render(
    <QueryClientProvider client={queryClient}>
      <GoogleCalendarOnboardingDialog
        open={overrides.open ?? true}
        onOpenChange={onOpenChange}
        onCompleted={onCompleted}
      />
    </QueryClientProvider>
  )
  return { onOpenChange, onCompleted }
}

describe('GoogleCalendarOnboardingDialog (M2)', () => {
  beforeEach(() => {
    listGoogleCalendars.mockReset()
    setDefaultGoogleCalendar.mockReset()
    listGoogleCalendars.mockResolvedValue(CALENDARS)
    setDefaultGoogleCalendar.mockResolvedValue({ success: true })
  })

  it('#given open #when calendars load #then preselects the primary calendar', async () => {
    renderDialog()

    await waitFor(() => {
      const select = screen.getByRole('combobox', { name: 'Target calendar' })
      expect((select as HTMLSelectElement).value).toBe('primary@example.com')
    })
  })

  it('#given user clicks "Use this calendar" #when primary is selected #then persists and calls onCompleted', async () => {
    const onCompleted = vi.fn()
    const onOpenChange = vi.fn()
    renderDialog({ onCompleted, onOpenChange })

    await waitFor(() => {
      const select = screen.getByRole('combobox', {
        name: 'Target calendar'
      }) as HTMLSelectElement
      expect(select.value).toBe('primary@example.com')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Use this calendar' }))

    await waitFor(() => {
      expect(setDefaultGoogleCalendar).toHaveBeenCalledWith({
        calendarId: 'primary@example.com',
        markOnboardingComplete: true
      })
    })
    expect(onCompleted).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('#given user clicks Skip #when invoked #then persists null and marks onboarding complete', async () => {
    renderDialog()

    await waitFor(() => {
      const select = screen.getByRole('combobox', {
        name: 'Target calendar'
      }) as HTMLSelectElement
      expect(select.value).toBe('primary@example.com')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))

    await waitFor(() => {
      expect(setDefaultGoogleCalendar).toHaveBeenCalledWith({
        calendarId: null,
        markOnboardingComplete: true
      })
    })
  })

  it('#given the IPC fails #when user confirms #then shows the error and keeps the dialog open', async () => {
    setDefaultGoogleCalendar.mockRejectedValueOnce(new Error('Disk offline'))
    const onOpenChange = vi.fn()
    renderDialog({ onOpenChange })

    await waitFor(() => {
      const select = screen.getByRole('combobox', {
        name: 'Target calendar'
      }) as HTMLSelectElement
      expect(select.value).toBe('primary@example.com')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Use this calendar' }))

    await waitFor(() => screen.getByRole('alert'))
    expect(screen.getByRole('alert').textContent).toContain('Disk offline')
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})
