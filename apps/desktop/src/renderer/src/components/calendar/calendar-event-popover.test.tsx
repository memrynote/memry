import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CalendarEventPopover } from './calendar-event-popover'
import type { CalendarEventDraft } from './types'

const mocks = vi.hoisted(() => ({
  googleCalendars: {
    data: {
      calendars: [
        { id: 'work', title: 'Work' },
        { id: 'home', title: 'Home' }
      ],
      currentDefaultId: 'work'
    },
    isLoading: false
  }
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.calendar ? `${key}:${options.calendar}` : key,
    i18n: { language: 'en-US' }
  })
}))

vi.mock('react-i18next', () => ({
  getI18n: () => ({
    getFixedT: () => (key: string) => key
  })
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({
    settings: { clockFormat: '12h' }
  })
}))

vi.mock('@/hooks/use-google-calendars', () => ({
  useGoogleCalendars: () => mocks.googleCalendars
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/components/tasks/date-picker-content', () => ({
  DatePickerContent: ({
    onSelect,
    onTimeChange
  }: {
    onSelect: (date: Date | undefined) => void
    onTimeChange?: (time: string | null) => void
  }) => (
    <div>
      <button type="button" onClick={() => onSelect(new Date(2026, 4, 12))}>
        pick date
      </button>
      {onTimeChange && (
        <button type="button" onClick={() => onTimeChange('14:30')}>
          pick time
        </button>
      )}
    </div>
  )
}))

vi.mock('./calendar-picker', () => ({
  CalendarPicker: ({
    defaultOptionLabel,
    disabled,
    onChange,
    value
  }: {
    defaultOptionLabel: string
    disabled?: boolean
    onChange: (value: string | null) => void
    value: string | null
  }) => (
    <div>
      <span>{defaultOptionLabel}</span>
      <button type="button" disabled={disabled} onClick={() => onChange(value ? null : 'home')}>
        choose calendar
      </button>
    </div>
  )
}))

vi.mock('./calendar-event-metadata', () => ({
  CalendarEventMetadata: () => <div>metadata shown</div>
}))

const baseDraft: CalendarEventDraft = {
  title: 'Planning',
  description: 'Notes',
  startAt: '2026-05-10T09:00',
  endAt: '2026-05-10T10:00',
  isAllDay: false,
  targetCalendarId: null,
  projectId: null
}

describe('CalendarEventPopover', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.googleCalendars = {
      data: {
        calendars: [
          { id: 'work', title: 'Work' },
          { id: 'home', title: 'Home' }
        ],
        currentDefaultId: 'work'
      },
      isLoading: false
    }
  })

  it('edits draft fields, date/time, target calendar, all-day state, and save failures', async () => {
    const onDraftChange = vi.fn()
    const onSave = vi.fn().mockRejectedValueOnce(new Error('save failed'))
    const onDismiss = vi.fn()

    render(
      <CalendarEventPopover
        anchorRect={{ x: 100, y: 120, width: 40, height: 20 }}
        mode="edit"
        draft={baseDraft}
        isSaving={false}
        onDraftChange={onDraftChange}
        onSave={onSave}
        onDismiss={onDismiss}
        readOnlyMetadata={{
          attendees: [],
          reminders: null,
          visibility: 'private',
          conferenceData: null
        }}
      />
    )

    fireEvent.change(screen.getByPlaceholderText('form.new-event-placeholder'), {
      target: { value: 'Updated planning' }
    })
    expect(onDraftChange).toHaveBeenCalledWith({ ...baseDraft, title: 'Updated planning' })

    fireEvent.change(screen.getByPlaceholderText('form.notes-url-placeholder'), {
      target: { value: 'Bring deck' }
    })
    expect(onDraftChange).toHaveBeenCalledWith({ ...baseDraft, description: 'Bring deck' })

    fireEvent.click(screen.getByRole('checkbox', { name: 'time.all-day' }))
    expect(onDraftChange).toHaveBeenCalledWith({
      ...baseDraft,
      isAllDay: true,
      startAt: '2026-05-10',
      endAt: '2026-05-10'
    })

    fireEvent.click(screen.getAllByText('pick date')[0])
    expect(onDraftChange).toHaveBeenCalledWith({ ...baseDraft, startAt: '2026-05-12T09:00' })
    fireEvent.click(screen.getAllByText('pick time')[0])
    expect(onDraftChange).toHaveBeenCalledWith({ ...baseDraft, startAt: '2026-05-10T14:30' })

    fireEvent.click(screen.getByText('choose calendar'))
    expect(onDraftChange).toHaveBeenCalledWith({ ...baseDraft, targetCalendarId: 'home' })
    expect(screen.getByText('form.use-default-calendar-with-name:Work')).toBeInTheDocument()
    expect(screen.getByText('metadata shown')).toBeInTheDocument()

    fireEvent.pointerDown(screen.getByTestId('event-edit-save'), { button: 0 })
    await waitFor(() =>
      expect(screen.getByTestId('event-edit-error')).toHaveTextContent('save failed')
    )
    fireEvent.click(screen.getByText('button.cancel'))
    expect(onDismiss).toHaveBeenCalled()
  })

  it('hides target calendar picker without calendars and skips empty-title saves', async () => {
    mocks.googleCalendars = {
      data: { calendars: [], currentDefaultId: null },
      isLoading: false
    }
    const onSave = vi.fn()

    render(
      <CalendarEventPopover
        anchorRect={{ x: 0, y: 0, width: 0, height: 0 }}
        mode="create"
        draft={{ ...baseDraft, title: '   ', targetCalendarId: 'work' }}
        isSaving={false}
        onDraftChange={vi.fn()}
        onSave={onSave}
        onDismiss={vi.fn()}
      />
    )

    expect(screen.queryByText('form.google-calendar')).not.toBeInTheDocument()
    expect(screen.getByTestId('event-edit-save')).toBeDisabled()
    fireEvent.keyDown(screen.getByPlaceholderText('form.new-event-placeholder'), { key: 'Enter' })
    expect(onSave).not.toHaveBeenCalled()
  })

  it('shows loading calendar defaults and restores timed values from all-day drafts', () => {
    mocks.googleCalendars = {
      data: undefined,
      isLoading: true
    }
    const onDraftChange = vi.fn()

    render(
      <CalendarEventPopover
        anchorRect={{ x: 0, y: 0, width: 0, height: 0 }}
        mode="create"
        draft={{ ...baseDraft, isAllDay: true, startAt: '2026-05-10', endAt: '' }}
        isSaving
        onDraftChange={onDraftChange}
        onSave={vi.fn()}
        onDismiss={vi.fn()}
      />
    )

    expect(screen.getByText('form.use-memry-calendar-default')).toBeInTheDocument()
    expect(screen.getByText('choose calendar')).toBeDisabled()
    expect(screen.getByTestId('event-edit-save')).toHaveTextContent('state.saving')

    fireEvent.click(screen.getAllByText('pick date')[0])
    expect(onDraftChange).toHaveBeenCalledWith({
      ...baseDraft,
      isAllDay: true,
      startAt: '2026-05-12',
      endAt: ''
    })

    fireEvent.click(screen.getByRole('checkbox', { name: 'time.all-day' }))
    expect(onDraftChange).toHaveBeenCalledWith({
      ...baseDraft,
      isAllDay: false,
      startAt: '2026-05-10T09:00',
      endAt: '2026-05-10T10:00'
    })
  })

  it('saves with Enter and edits the end date controls', async () => {
    const onDraftChange = vi.fn()
    const onSave = vi.fn()

    render(
      <CalendarEventPopover
        anchorRect={{ x: 0, y: 0, width: 0, height: 0 }}
        mode="edit"
        draft={baseDraft}
        isSaving={false}
        onDraftChange={onDraftChange}
        onSave={onSave}
        onDismiss={vi.fn()}
      />
    )

    fireEvent.keyDown(screen.getByPlaceholderText('form.new-event-placeholder'), { key: 'Enter' })
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getAllByText('pick date')[1])
    expect(onDraftChange).toHaveBeenCalledWith({ ...baseDraft, endAt: '2026-05-12T10:00' })

    fireEvent.click(screen.getAllByText('pick time')[1])
    expect(onDraftChange).toHaveBeenCalledWith({ ...baseDraft, endAt: '2026-05-10T14:30' })

    fireEvent.pointerDown(screen.getByTestId('event-edit-save'), { button: 1 })
    expect(onSave).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('event-edit-save'))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2))
  })

  it('falls back for invalid date values and ignores save attempts while saving', () => {
    const onDraftChange = vi.fn()
    const onSave = vi.fn()

    render(
      <CalendarEventPopover
        anchorRect={{ x: 0, y: 0, width: 0, height: 0 }}
        mode="edit"
        draft={{ ...baseDraft, startAt: '', endAt: 'bad-date' }}
        isSaving
        onDraftChange={onDraftChange}
        onSave={onSave}
        onDismiss={vi.fn()}
      />
    )

    expect(screen.getAllByText('time.pick-a-date')).toHaveLength(2)

    fireEvent.click(screen.getAllByText('pick date')[1])
    expect(onDraftChange).toHaveBeenCalledWith({
      ...baseDraft,
      startAt: '',
      endAt: '2026-05-12T09:00'
    })

    fireEvent.keyDown(screen.getByPlaceholderText('form.new-event-placeholder'), { key: 'Enter' })
    expect(onSave).not.toHaveBeenCalled()
  })
})
