/**
 * ChartSettings writes the chart into a note's definition, so what it writes is
 * the contract: a default is never written (the key is dropped instead), a new
 * property brings its own suggested chart, and each setting shows only for the
 * charts it changes.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ViewBlockChart } from '@memry/shared/view-block'
import { ChartSettings, patchChart } from './chart-settings'

const PROPERTIES = [
  { name: 'sleep', type: 'number' },
  { name: 'workout', type: 'checkbox' },
  { name: 'reviewOn', type: 'date' }
]

function open(chart: ViewBlockChart, needsDateFrom = false) {
  const onChange = vi.fn()
  render(
    <ChartSettings
      chart={chart}
      properties={PROPERTIES}
      needsDateFrom={needsDateFrom}
      onChange={onChange}
      defaultOpen
    />
  )
  return onChange
}

describe('ChartSettings', () => {
  it('resets the chart type and range when another property is picked', async () => {
    const onChange = open({ property: 'sleep', type: 'bar', rangeDays: 90 })

    await userEvent.click(screen.getByRole('option', { name: /workout/ }))

    expect(onChange).toHaveBeenCalledWith({
      property: 'workout',
      type: undefined,
      rangeDays: undefined
    })
  })

  it('offers the types the property can draw and drops the suggested one from the definition', async () => {
    const onChange = open({ property: 'sleep', type: 'bar' })

    const types = screen.getAllByRole('radio').map((radio) => radio.textContent)
    expect(types).toEqual(['LineSuggested', 'Bar', 'Heatmap'])

    await userEvent.click(screen.getByRole('radio', { name: /Line/ }))
    expect(onChange).toHaveBeenCalledWith({ type: undefined, rangeDays: undefined })
  })

  it('shows number-only settings for numbers, and Date from only off the journal', () => {
    open({ property: 'workout' })
    expect(screen.queryByTestId('chart-aggregate')).toBeNull()
    expect(screen.queryByTestId('chart-missing')).toBeNull()
    expect(screen.queryByTestId('chart-date-from')).toBeNull()
  })

  it('writes a picked date property as Date from, and Created as no key at all', async () => {
    const onChange = open({ property: 'sleep', dateFrom: 'reviewOn' }, true)
    expect(screen.getByTestId('chart-aggregate')).toBeInTheDocument()
    expect(screen.getByTestId('chart-missing')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('chart-date-from'))
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Created' }))

    expect(onChange).toHaveBeenCalledWith({ dateFrom: undefined })
  })
})

describe('patchChart', () => {
  it('drops keys patched back to their default', () => {
    expect(
      patchChart({ property: 'sleep', type: 'bar' }, { type: undefined, rangeDays: 90 })
    ).toEqual({
      property: 'sleep',
      rangeDays: 90
    })
  })
})
