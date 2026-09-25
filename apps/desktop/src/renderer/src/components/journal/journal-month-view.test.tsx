import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import type { HeatmapEntry } from '@/hooks/use-journal'
import { JournalMonthView, type JournalEntryData } from './journal-month-view'

async function renderSeptember2025(
  entries: Map<string, JournalEntryData>,
  heatmapData: HeatmapEntry[]
): Promise<void> {
  const i18n = await createRendererI18n({ locale: 'en' })
  render(
    <I18nextProvider i18n={i18n}>
      <JournalMonthView
        year={2025}
        month={8}
        entries={entries}
        heatmapData={heatmapData}
        onDayClick={vi.fn()}
      />
    </I18nextProvider>
  )
}

/** The row button for a day of the month; rows start with the day number. */
function rowForDay(day: number): HTMLElement {
  const row = screen
    .getAllByRole('button')
    .find((button) => button.textContent?.startsWith(String(day)))
  if (!row) throw new Error(`no row for day ${day}`)
  return row
}

/** The activity dot is filled (has a background color) only for an entry. */
function hasFilledDot(row: HTMLElement): boolean {
  return row.querySelector('span[style*="background-color"]') !== null
}

describe('JournalMonthView', () => {
  it('shows an entry whose characterCount is NULL/0 and has no heatmap level as an entry', async () => {
    // Tier-0 stat scan row: characterCount NULL, served as 0, heatmap level 0.
    await renderSeptember2025(
      new Map([['2025-09-21', { preview: 'First note of September', characterCount: 0 }]]),
      [{ date: '2025-09-21', characterCount: 0, level: 0 }]
    )

    const row = rowForDay(21)
    expect(within(row).getByText('First note of September')).toBeInTheDocument()
    expect(within(row).queryByText('No entry')).not.toBeInTheDocument()
    expect(hasFilledDot(row)).toBe(true)

    expect(within(rowForDay(20)).getByText('No entry')).toBeInTheDocument()
    expect(hasFilledDot(rowForDay(20))).toBe(false)
  })

  it('shows an entry even when the heatmap has no row for it', async () => {
    await renderSeptember2025(
      new Map([['2025-09-21', { preview: 'First note of September', characterCount: 40 }]]),
      []
    )

    const row = rowForDay(21)
    expect(within(row).getByText('First note of September')).toBeInTheDocument()
    expect(hasFilledDot(row)).toBe(true)
  })

  it('does not label an existing empty entry as "No entry"', async () => {
    await renderSeptember2025(new Map([['2025-09-21', { preview: '', characterCount: 0 }]]), [
      { date: '2025-09-21', characterCount: 0, level: 0 }
    ])

    const row = rowForDay(21)
    expect(within(row).queryByText('No entry')).not.toBeInTheDocument()
    expect(hasFilledDot(row)).toBe(true)
  })

  it('keeps the heatmap level for an entry with content', async () => {
    await renderSeptember2025(
      new Map([['2025-09-21', { preview: 'Long entry', characterCount: 900 }]]),
      [{ date: '2025-09-21', characterCount: 900, level: 3 }]
    )

    const dot = rowForDay(21).querySelector<HTMLElement>('span[style*="background-color"]')
    // HEATMAP_COLORS[3] = #30a14e
    expect(dot?.style.backgroundColor).toBe('rgb(48, 161, 78)')
  })
})
