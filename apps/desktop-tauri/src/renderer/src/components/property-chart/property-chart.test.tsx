/**
 * PropertyChart: what each kind of property draws and sums up. The day maths
 * is chart-model's subject; here it is the reader's side of it: the figures
 * over the chart, the chart a type picks, the colour a select day gets, and
 * which day a click on the chart opens.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTagColors } from '@/components/note/tags-row/tag-colors'
import { addDays, type ChartRow } from '@/lib/property-chart/chart-model'
import { PropertyChart } from './property-chart'

const TODAY = '2026-09-30'
const day = (offset: number): string => addDays(TODAY, offset)
const row = (offset: number, properties: Record<string, unknown>): ChartRow => ({
  id: `r${offset}`,
  day: day(offset),
  properties
})
const stat = (label: string): string | null =>
  screen.getByText(label).nextElementSibling?.textContent ?? null

describe('PropertyChart', () => {
  beforeEach(() => {
    // jsdom lays nothing out; the charts draw only once they have a width.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('draws a number as a line with its average, change and lowest day, and opens a day', () => {
    // #given sleep for the last three days and one day in the period before
    const onOpenDay = vi.fn()
    const rows = [
      row(-31, { sleep: 6 }),
      row(-2, { sleep: 7 }),
      row(-1, { sleep: 6.5 }),
      row(0, { sleep: 8.5 })
    ]

    render(
      <PropertyChart
        rows={rows}
        property="sleep"
        propertyType="number"
        chart={{}}
        today={TODAY}
        onOpenDay={onOpenDay}
      />
    )

    // #then a month-long line, summed up against the month before
    const chart = screen.getByRole('img', { name: 'sleep over the last 30 days' })
    expect(chart.closest('[data-property-chart]')).toHaveAttribute('data-property-chart', 'line')
    expect(stat('Average')).toBe('7.3')
    expect(stat('vs previous period')).toBe('+1.3')
    expect(stat('Lowest')).toMatch(/^6\.5 · /)

    // #when the pointer is on the right edge, over today, and clicks
    fireEvent.pointerMove(chart, { clientX: 630 })
    fireEvent.click(chart)

    // #then today opens, and its value is in the tooltip
    expect(onOpenDay).toHaveBeenCalledWith(expect.objectContaining({ day: TODAY, value: 8.5 }))
    expect(screen.getByRole('presentation')).toHaveTextContent('8.5')
  })

  it('draws bars when asked, and does not open a day nothing was recorded on', () => {
    const onOpenDay = vi.fn()
    render(
      <PropertyChart
        rows={[row(-5, { steps: 9000 })]}
        property="steps"
        propertyType="number"
        chart={{ type: 'bar', rangeDays: 7 }}
        today={TODAY}
        onOpenDay={onOpenDay}
      />
    )

    const chart = screen.getByRole('img', { name: 'steps over the last 7 days' })
    expect(chart.querySelectorAll('rect')).toHaveLength(1)
    fireEvent.pointerMove(chart, { clientX: 630 })
    fireEvent.click(chart)
    expect(onOpenDay).not.toHaveBeenCalled()
    expect(screen.getByRole('presentation')).toHaveTextContent('No entry')
  })

  it('colours a select day with its option colour and names the usual value', () => {
    // #given a feeling select whose "great" option is emerald
    render(
      <PropertyChart
        rows={[
          row(-2, { feeling: 'great' }),
          row(-1, { feeling: 'great' }),
          row(0, { feeling: 'low' })
        ]}
        property="feeling"
        propertyType="select"
        optionColors={new Map([['great', 'emerald']])}
        chart={{ rangeDays: 7 }}
        today={TODAY}
      />
    )

    // #then a heatmap, today's square last
    const cells = [...screen.getByRole('img').querySelectorAll('rect')]
    expect(cells).toHaveLength(7)
    expect(cells[cells.length - 2].style.fill).toBe(getTagColors('emerald').background)
    expect(stat('Most common')).toBe('great')
    expect(stat('Logged')).toBe('3 / 7')
  })

  it('counts multi-select values as bars of how often each was picked', () => {
    render(
      <PropertyChart
        rows={[row(-1, { habits: ['Reading', 'Walk'] }), row(0, { habits: ['Walk'] })]}
        property="habits"
        propertyType="multiselect"
        chart={{ rangeDays: 7 }}
        today={TODAY}
      />
    )

    const bars = screen.getByRole('list', { name: 'habits over the last 7 days' })
    expect([...bars.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'Walk2',
      'Reading1'
    ])
  })

  it('says so when nothing was recorded in the range', () => {
    render(
      <PropertyChart rows={[]} property="sleep" propertyType="number" chart={{}} today={TODAY} />
    )
    expect(screen.getByText('Nothing recorded in this range yet.')).toBeInTheDocument()
    expect(screen.queryByText('Average')).toBeNull()
  })
})
