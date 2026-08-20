import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

// Radix Select drives its trigger through the Pointer Capture API and scrolls
// the checked item into view on open; jsdom implements neither.
beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})

const setWeekdayTemplate = vi.fn().mockResolvedValue(true)
const journalSettings = {
  defaultTemplate: 'morning-pages' as string | null,
  weekdayTemplates: {} as Record<string, string | null>,
  showSchedule: true,
  showTasks: true,
  showAIConnections: true,
  showStatsFooter: false
}
let weekStartsOn: 0 | 1 = 1

vi.mock('@/hooks/use-journal-settings', () => ({
  useJournalSettings: () => ({
    settings: journalSettings,
    isLoading: false,
    error: null,
    updateSettings: vi.fn().mockResolvedValue(true),
    setDefaultTemplate: vi.fn().mockResolvedValue(true),
    setWeekdayTemplate
  })
}))

vi.mock('@/hooks/use-templates', () => ({
  useTemplates: () => ({
    templates: [
      { id: 'morning-pages', name: 'Morning Pages', icon: null, isBuiltIn: true },
      { id: 'daily-standup', name: 'Daily Standup', icon: null, isBuiltIn: true }
    ],
    isLoading: false
  })
}))

vi.mock('@/hooks/use-vault', () => ({
  useVault: () => ({
    config: { journalFolder: 'journal', journalDateFormat: 'YYYY-MM-DD' },
    updateConfig: vi.fn()
  })
}))

vi.mock('@/hooks/use-calendar-preferences', () => ({
  useCalendarPreferences: () => ({
    settings: { dayCellClickBehavior: 'journal', calendarPageClickOverride: 'inherit' },
    isLoading: false,
    updateSettings: vi.fn()
  }),
  useWeekStartsOn: () => weekStartsOn
}))

import { JournalSettings } from './journal-section'

const DAY_ORDER = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function renderedDayNames(): string[] {
  return screen
    .getAllByTestId(/^journal-weekday-\d$/)
    .map((row) => row.textContent ?? '')
    .map((text) => DAY_ORDER.find((day) => text.startsWith(day)) ?? '')
}

async function expand(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByTestId('journal-per-day-toggle').querySelector('button')!)
}

describe('Journal settings — per-day templates', () => {
  beforeEach(() => {
    setWeekdayTemplate.mockClear()
    journalSettings.defaultTemplate = 'morning-pages'
    journalSettings.weekdayTemplates = {}
    weekStartsOn = 1
  })

  it('keeps the per-day rows collapsed until asked', async () => {
    const user = userEvent.setup()
    render(<JournalSettings />)

    expect(screen.queryAllByTestId(/^journal-weekday-\d$/)).toHaveLength(0)
    await expand(user)
    expect(screen.getAllByTestId(/^journal-weekday-\d$/)).toHaveLength(7)
  })

  it('starts expanded when days are already configured', async () => {
    journalSettings.weekdayTemplates = { '1': 'daily-standup' }
    render(<JournalSettings />)

    // A configured setting must never hide behind a collapsed row.
    await waitFor(() => expect(screen.getAllByTestId(/^journal-weekday-\d$/)).toHaveLength(7))
  })

  it('orders rows by the first-day-of-week preference', async () => {
    const user = userEvent.setup()
    render(<JournalSettings />)
    await expand(user)

    expect(renderedDayNames()).toEqual([
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
      'Sunday'
    ])
  })

  it('reorders — but never relabels — when the week starts on Sunday', async () => {
    weekStartsOn = 0
    journalSettings.weekdayTemplates = { '1': 'daily-standup' }
    const user = userEvent.setup()
    render(<JournalSettings />)
    await waitFor(() => expect(screen.getAllByTestId(/^journal-weekday-\d$/)).toHaveLength(7))

    expect(renderedDayNames()[0]).toBe('Sunday')
    // The Monday template is still on Monday: rows are keyed by absolute
    // weekday, so the preference can only change the order they appear in.
    expect(screen.getByTestId('journal-weekday-1').textContent).toContain('Daily Standup')
    void user
  })

  it('shows the resolved fallback on an unset day, not a bare "Default"', async () => {
    const user = userEvent.setup()
    render(<JournalSettings />)
    await expand(user)

    expect(screen.getByTestId('journal-weekday-1').textContent).toContain('Default · Morning Pages')
  })

  it('says so when the fallback itself is unset', async () => {
    journalSettings.defaultTemplate = null
    const user = userEvent.setup()
    render(<JournalSettings />)
    await expand(user)

    expect(screen.getByTestId('journal-weekday-1').textContent).toContain('Default · none')
  })

  it('flags a day pointing at a deleted template', async () => {
    journalSettings.weekdayTemplates = { '4': 'gone-template' }
    render(<JournalSettings />)
    await waitFor(() => expect(screen.getAllByTestId(/^journal-weekday-\d$/)).toHaveLength(7))

    expect(screen.getByTestId('journal-weekday-4').textContent).toContain('Deleted template')
  })

  it('writes the absolute weekday, not the row position', async () => {
    const user = userEvent.setup()
    render(<JournalSettings />)
    await expand(user)

    // Wednesday is the third row under a Monday-start week; the value written
    // must be 3 (getDay()), never 2 (its index).
    await user.click(screen.getByRole('combobox', { name: 'Wednesday' }))
    await user.click(await screen.findByRole('option', { name: /Daily Standup/ }))

    await waitFor(() => expect(setWeekdayTemplate).toHaveBeenCalledWith(3, 'daily-standup'))
  })
})
