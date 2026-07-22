import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CanvasEventEditor, toDraft } from './canvas-event-editor'
import { toLocalDateInputValue, toLocalDateTimeInputValue } from '@/components/calendar/date-utils'
import type { CalendarEventRecord } from '@/services/calendar-service'
import type { CalendarEventDraft } from '@/components/calendar/types'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

const mocks = vi.hoisted(() => ({
  getEvent: vi.fn(),
  updateEvent: vi.fn()
}))

vi.mock('@/services/calendar-service', () => ({
  calendarService: { getEvent: mocks.getEvent, updateEvent: mocks.updateEvent }
}))

// Stub the extracted form so this test exercises CanvasEventEditor's own
// load/save wiring, not the form's own field rendering (covered elsewhere).
vi.mock('@/components/calendar/calendar-event-form', () => ({
  CalendarEventForm: ({
    draft,
    onSave,
    onDismiss
  }: {
    draft: CalendarEventDraft
    onSave: () => void
    onDismiss: () => void
  }) => (
    <div>
      <span data-testid="draft-title">{draft.title}</span>
      <button data-testid="save" onClick={() => void onSave()} />
      <button data-testid="dismiss" onClick={onDismiss} />
    </div>
  )
}))

function makeEvent(overrides: Partial<CalendarEventRecord> = {}): CalendarEventRecord {
  return {
    id: 'ev1',
    title: 'Standup',
    description: 'daily sync',
    location: null,
    startAt: '2026-08-01T10:00:00.000Z',
    endAt: '2026-08-01T10:30:00.000Z',
    timezone: 'UTC',
    isAllDay: false,
    recurrenceRule: null,
    recurrenceExceptions: null,
    attendees: null,
    reminders: null,
    visibility: null,
    colorId: null,
    conferenceData: null,
    parentEventId: null,
    originalStartTime: null,
    targetCalendarId: null,
    archivedAt: null,
    syncedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

describe('toDraft', () => {
  it('converts a timed event to local datetime inputs', () => {
    const event = makeEvent()
    const draft = toDraft(event)
    expect(draft.title).toBe('Standup')
    expect(draft.description).toBe('daily sync')
    expect(draft.isAllDay).toBe(false)
    expect(draft.startAt).toBe(toLocalDateTimeInputValue(event.startAt))
    expect(draft.endAt).toBe(toLocalDateTimeInputValue(event.endAt as string))
    expect(draft.targetCalendarId).toBeNull()
  })

  it('converts an all-day event to local date-only inputs', () => {
    const event = makeEvent({ isAllDay: true, endAt: '2026-08-02T00:00:00.000Z' })
    const draft = toDraft(event)
    expect(draft.startAt).toBe(toLocalDateInputValue(event.startAt))
    expect(draft.endAt).toBe(toLocalDateInputValue(event.endAt as string))
  })

  it('leaves endAt empty when the event has no end', () => {
    const event = makeEvent({ endAt: null })
    const draft = toDraft(event)
    expect(draft.endAt).toBe('')
  })

  it('falls back to an empty description when null', () => {
    const event = makeEvent({ description: null })
    expect(toDraft(event).description).toBe('')
  })
})

describe('CanvasEventEditor', () => {
  beforeEach(() => {
    mocks.getEvent.mockReset()
    mocks.updateEvent.mockReset()
  })

  it('shows a loading state until the event resolves', async () => {
    mocks.getEvent.mockReturnValue(new Promise(() => {})) // never resolves
    render(<CanvasEventEditor eventId="ev1" onDone={vi.fn()} />)
    expect(screen.getByText('state.loading')).toBeInTheDocument()
  })

  it('renders the form once the event loads', async () => {
    mocks.getEvent.mockResolvedValue(makeEvent())
    render(<CanvasEventEditor eventId="ev1" onDone={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('draft-title')).toHaveTextContent('Standup'))
  })

  it('saves via calendarService.updateEvent and calls onDone', async () => {
    mocks.getEvent.mockResolvedValue(makeEvent())
    mocks.updateEvent.mockResolvedValue({ success: true })
    const onDone = vi.fn()
    render(<CanvasEventEditor eventId="ev1" onDone={onDone} />)
    await waitFor(() => expect(screen.getByTestId('save')).toBeInTheDocument())
    screen.getByTestId('save').click()
    await waitFor(() => expect(mocks.updateEvent).toHaveBeenCalled())
    const payload = mocks.updateEvent.mock.calls[0][0]
    expect(payload).toMatchObject({ id: 'ev1', title: 'Standup', isAllDay: false })
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
  })

  it('dismiss calls onDone without saving', async () => {
    mocks.getEvent.mockResolvedValue(makeEvent())
    const onDone = vi.fn()
    render(<CanvasEventEditor eventId="ev1" onDone={onDone} />)
    await waitFor(() => expect(screen.getByTestId('dismiss')).toBeInTheDocument())
    screen.getByTestId('dismiss').click()
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(mocks.updateEvent).not.toHaveBeenCalled()
  })
})
