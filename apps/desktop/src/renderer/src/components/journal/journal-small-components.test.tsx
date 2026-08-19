import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { DateBreadcrumb } from './date-breadcrumb'
import { DefaultTemplateIndicator } from './default-template-indicator'
import { JournalDateDisplay } from './journal-date-display'
import { JournalReminderButton } from './journal-reminder-button'

const mocks = vi.hoisted(() => ({
  setReminder: vi.fn(),
  reminderState: {
    hasActiveReminder: false,
    nextReminder: null as null | { remindAt: string },
    activeReminderCount: 0
  }
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      [key, params?.templateName, params?.date, params?.count].filter(Boolean).join(':')
  })
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: { clockFormat: '24h' } })
}))

vi.mock('@/hooks/use-journal-reminders', () => ({
  useJournalReminders: () => ({
    ...mocks.reminderState,
    actions: { setReminder: mocks.setReminder }
  })
}))

vi.mock('@/lib/telemetry', () => ({ trackTelemetry: vi.fn() }))

// The real `ReminderPicker` renders here on purpose: a hand-written stub would
// re-declare `onSelect` from this file's reading of it, which is exactly how the
// note-dropping bug in #1527 stayed green. Only the Radix primitive underneath
// is stood in, because it does not open in jsdom.
vi.mock('@/components/ui/picker', async () => {
  const { createPickerStub } = await import('@tests/utils/picker-stub')
  return createPickerStub()
})

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

describe('journal small components', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    mocks.reminderState = {
      hasActiveReminder: false,
      nextReminder: null,
      activeReminderCount: 0
    }
  })

  it('renders and navigates day, month, and year breadcrumbs', () => {
    const onMonthClick = vi.fn()
    const onYearClick = vi.fn()
    const onBackClick = vi.fn()
    const onPreviousDay = vi.fn()
    const onNextDay = vi.fn()

    const { rerender } = render(
      <DateBreadcrumb
        viewState={{ type: 'day', date: '2026-05-10' }}
        onMonthClick={onMonthClick}
        onYearClick={onYearClick}
        onBackClick={onBackClick}
        onPreviousDay={onPreviousDay}
        onNextDay={onNextDay}
      />
    )

    fireEvent.click(screen.getByLabelText('nav.previousDay'))
    fireEvent.click(screen.getByLabelText('nav.nextDay'))
    fireEvent.click(screen.getByText('2026'))
    expect(onPreviousDay).toHaveBeenCalled()
    expect(onNextDay).toHaveBeenCalled()
    expect(onYearClick).toHaveBeenCalledWith(2026)

    rerender(
      <DateBreadcrumb
        viewState={{ type: 'month', year: 2026, month: 4 }}
        onMonthClick={onMonthClick}
        onYearClick={onYearClick}
        onBackClick={onBackClick}
      />
    )
    fireEvent.click(screen.getByLabelText('nav.journalBack'))
    expect(onBackClick).toHaveBeenCalled()

    rerender(
      <DateBreadcrumb
        viewState={{ type: 'year', year: 2026 }}
        onMonthClick={onMonthClick}
        onYearClick={onYearClick}
        onBackClick={onBackClick}
      />
    )
    expect(screen.getByText('2026')).toBeInTheDocument()
  })

  it('renders date display variants', () => {
    const { rerender } = render(
      <JournalDateDisplay
        viewState={{ type: 'day', date: '2026-05-10' }}
        dateParts={{ day: 10, month: 'May', monthIndex: 4, year: 2026, dayName: 'Sunday' }}
      />
    )
    expect(screen.getByText('Sunday, May 10')).toBeInTheDocument()

    rerender(
      <JournalDateDisplay viewState={{ type: 'month', year: 2026, month: 4 }} dateParts={null} />
    )
    expect(screen.getByText(/2026/)).toBeInTheDocument()

    rerender(<JournalDateDisplay viewState={{ type: 'year', year: 2027 }} dateParts={null} />)
    expect(screen.getByText('2027')).toBeInTheDocument()
  })

  it('handles template indicator actions and auto-dismiss', async () => {
    vi.useFakeTimers()
    const onChangeTemplate = vi.fn()
    const onStartBlank = vi.fn()

    render(
      <DefaultTemplateIndicator
        templateName="Daily"
        templateIcon="D"
        isCreating
        onChangeTemplate={onChangeTemplate}
        onStartBlank={onStartBlank}
      />
    )

    fireEvent.click(screen.getByText('action.changeTemplate'))
    fireEvent.click(screen.getByText('action.startBlank'))
    expect(onChangeTemplate).toHaveBeenCalled()
    expect(onStartBlank).toHaveBeenCalled()

    fireEvent.click(screen.getByLabelText('action.dismissIndicator'))
    await act(async () => {
      vi.advanceTimersByTime(301)
    })
    expect(screen.queryByText('template.using:Daily')).not.toBeInTheDocument()
  })

  it('sets journal reminders and shows active reminder count', () => {
    mocks.reminderState = {
      hasActiveReminder: true,
      nextReminder: { remindAt: '2026-05-10T12:00:00Z' },
      activeReminderCount: 3
    }

    render(<JournalReminderButton journalDate="2026-05-10" />)
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getAllByText(/reminder.tooltipMore/).length).toBeGreaterThan(0)

    // The note goes in through the picker's own textarea, so it only reaches
    // `setReminder` if this button reads the argument the picker actually sends.
    fireEvent.change(
      screen.getByPlaceholderText('phaseF.componentsReminderReminderPicker.addANoteOptional'),
      { target: { value: 'reflect' } }
    )
    fireEvent.click(screen.getByTestId('preset-in-one-week'))
    expect(mocks.setReminder).toHaveBeenCalledWith(expect.any(Date), 'reflect')
  })
})
