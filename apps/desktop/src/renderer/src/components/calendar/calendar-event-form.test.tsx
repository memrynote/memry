import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CalendarEventForm } from './calendar-event-form'
import type { CalendarEventDraft } from './types'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => key,
    i18n: { language: 'en-US' }
  })
}))

vi.mock('react-i18next', () => ({
  getI18n: () => ({ getFixedT: () => (key: string) => key })
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: { clockFormat: '12h' } })
}))

vi.mock('@/hooks/use-google-calendars', () => ({
  useGoogleCalendars: () => ({ data: { calendars: [], currentDefaultId: null }, isLoading: false })
}))

vi.mock('./calendar-picker', () => ({
  CalendarPicker: () => <div>calendar picker</div>
}))

vi.mock('./calendar-event-metadata', () => ({
  CalendarEventMetadata: () => <div>metadata</div>
}))

vi.mock('./event-project-field', () => ({
  EventProjectField: () => <div>project field</div>
}))

const AVAILABLE_HEIGHT = '--radix-popover-content-available-height'

const draft: CalendarEventDraft = {
  title: 'Planning',
  description: '',
  startAt: '2026-03-16T09:00',
  endAt: '2026-03-16T10:00',
  isAllDay: false,
  targetCalendarId: null,
  projectId: null
}

const openStartDatePopover = (): HTMLElement => {
  render(
    <CalendarEventForm
      mode="create"
      draft={draft}
      isSaving={false}
      onDraftChange={vi.fn()}
      onSave={vi.fn()}
      onDismiss={vi.fn()}
      autoFocus={false}
    />
  )
  fireEvent.click(screen.getByText('form.start'))
  const content = document.querySelector<HTMLElement>('[data-radix-popper-content-wrapper] > *')
  expect(content).not.toBeNull()
  return content!
}

/**
 * Structural only, like `picker-content.test.tsx`: jsdom computes no layout and
 * never resolves the Radix variable, so this cannot show the panel is on
 * screen — only that the popover asks to be bounded and can shrink.
 */
describe('CalendarEventForm date popover height', () => {
  it('caps the date panel at the height Radix measured', () => {
    // This form is hosted by an event popover that can itself sit low in the
    // calendar grid, and a raw `PopoverContent` never applies the available
    // height the popper measures.
    const content = openStartDatePopover()

    expect(content.className).not.toContain(`max-h-[${AVAILABLE_HEIGHT}]`)
    expect(content.className).toMatch(
      new RegExp(`max-h-(?:\\(${AVAILABLE_HEIGHT}\\)|\\[var\\(${AVAILABLE_HEIGHT}\\)\\])`)
    )
  })

  it('lays out as a column so the cap reaches the scrolling body', () => {
    const content = openStartDatePopover()

    expect(content.className).toContain('flex')
    expect(content.className).toContain('flex-col')
  })
})
