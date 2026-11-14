import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import type { SameDayEntry } from '@memry/contracts/journal-api'
import { renderWithProviders, getMockApi, userEvent } from '@tests/utils/render'
import { JournalPastYears } from './journal-past-years'

// The full-year layout's read-only bodies pull BlockNote and react-pdf, which need DOMMatrix jsdom lacks.
vi.mock('@/pages/canvas/canvas-note-body', () => ({
  CanvasNoteBody: ({ markdown }: { markdown: string }) => <div>{markdown}</div>
}))

function seedSameDay(entries: SameDayEntry[]): ReturnType<typeof vi.fn> {
  const api = getMockApi() as unknown as {
    journal: { getSameDayEntries: ReturnType<typeof vi.fn> }
  }
  api.journal.getSameDayEntries.mockResolvedValue(entries)
  return api.journal.getSameDayEntries
}

const entry = (date: string, content: string): SameDayEntry => ({
  id: `j${date}`,
  date,
  preview: content,
  content,
  wordCount: content.split(' ').length
})

describe('JournalPastYears', () => {
  it('lists the same day in other years and opens the one clicked', async () => {
    const getSameDay = seedSameDay([
      entry('2026-11-10', 'Booked the flights'),
      entry('2024-11-10', 'Dinner at Mom’s')
    ])
    const onOpenDay = vi.fn()
    renderWithProviders(
      <JournalPastYears
        date="2025-11-10"
        today="2026-11-10"
        allYears={false}
        onToggleAllYears={vi.fn()}
        onOpenDay={onOpenDay}
      />
    )

    expect(await screen.findByText('Dinner at Mom’s')).toBeInTheDocument()
    expect(getSameDay).toHaveBeenCalledWith('2025-11-10')
    expect(screen.getByText(/Today · 3 words/)).toBeInTheDocument()
    expect(screen.getByText(/1 year ago · 3 words/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Open 2024-11-10' }))
    expect(onOpenDay).toHaveBeenCalledWith('2024-11-10')
  })

  it('renders nothing when no other year has text on this day', async () => {
    const getSameDay = seedSameDay([])
    const { container } = renderWithProviders(
      <JournalPastYears
        date="2026-11-10"
        today="2026-11-10"
        allYears={false}
        onToggleAllYears={vi.fn()}
        onOpenDay={vi.fn()}
      />
    )

    await vi.waitFor(() => expect(getSameDay).toHaveBeenCalled())
    expect(container.querySelector('[data-journal-past-years]')).toBeNull()
  })

  it('shows every year in full and labels a leap day by its real date', async () => {
    seedSameDay([entry('2024-02-29', 'Took the leap day off')])
    renderWithProviders(
      <JournalPastYears
        date="2027-02-28"
        today="2027-02-28"
        allYears
        onToggleAllYears={vi.fn()}
        onOpenDay={vi.fn()}
      />
    )

    expect(await screen.findByText('Took the leap day off')).toBeInTheDocument()
    expect(screen.getByText('February 29')).toBeInTheDocument()
    expect(screen.getByText('3 years ago')).toBeInTheDocument()
  })
})
