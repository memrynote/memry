import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ReviewTimeInput } from './review-time-input'

const tid = 't'
const hour = () => screen.getByTestId('t-hour')
const minute = () => screen.getByTestId('t-minute')
const period = () => screen.queryByTestId('t-period')

describe('ReviewTimeInput — 24h', () => {
  it('renders hour + minute, no AM/PM toggle', () => {
    render(<ReviewTimeInput data-testid={tid} value="08:45" clockFormat="24h" onChange={vi.fn()} />)
    expect(hour()).toHaveValue('08')
    expect(minute()).toHaveValue('45')
    expect(period()).toBeNull()
  })

  it('emits canonical HH:MM on blur', () => {
    const onChange = vi.fn()
    render(
      <ReviewTimeInput data-testid={tid} value="08:00" clockFormat="24h" onChange={onChange} />
    )
    fireEvent.change(minute(), { target: { value: '45' } })
    fireEvent.blur(minute())
    expect(onChange).toHaveBeenCalledWith('08:45')
  })

  it('does not clobber the second digit while typing (the reported bug)', () => {
    render(<ReviewTimeInput data-testid={tid} value="08:00" clockFormat="24h" onChange={vi.fn()} />)
    fireEvent.focus(hour())
    fireEvent.change(hour(), { target: { value: '0' } })
    fireEvent.change(hour(), { target: { value: '08' } })
    // Local draft holds the full value; it is not reset to the persisted "08" mid-entry.
    expect(hour()).toHaveValue('08')
  })

  it('clamps out-of-range input on blur', () => {
    const onChange = vi.fn()
    render(
      <ReviewTimeInput data-testid={tid} value="08:00" clockFormat="24h" onChange={onChange} />
    )
    fireEvent.change(hour(), { target: { value: '99' } })
    fireEvent.blur(hour())
    expect(onChange).toHaveBeenCalledWith('23:00')
  })
})

describe('ReviewTimeInput — 12h', () => {
  it('renders 12h hour + AM/PM toggle', () => {
    render(<ReviewTimeInput data-testid={tid} value="18:00" clockFormat="12h" onChange={vi.fn()} />)
    expect(hour()).toHaveValue('06')
    expect(period()).toHaveTextContent('PM')
  })

  it('maps midnight and noon correctly', () => {
    const { rerender } = render(
      <ReviewTimeInput data-testid={tid} value="00:30" clockFormat="12h" onChange={vi.fn()} />
    )
    expect(hour()).toHaveValue('12')
    expect(period()).toHaveTextContent('AM')

    rerender(
      <ReviewTimeInput data-testid={tid} value="12:00" clockFormat="12h" onChange={vi.fn()} />
    )
    expect(hour()).toHaveValue('12')
    expect(period()).toHaveTextContent('PM')
  })

  it('toggling PM→AM re-emits the converted 24h value', () => {
    const onChange = vi.fn()
    render(
      <ReviewTimeInput data-testid={tid} value="18:00" clockFormat="12h" onChange={onChange} />
    )
    fireEvent.click(period()!)
    expect(onChange).toHaveBeenCalledWith('06:00') // 6 AM
  })

  it('emits 24h canonical from 12h fields on blur', () => {
    const onChange = vi.fn()
    render(
      <ReviewTimeInput data-testid={tid} value="18:00" clockFormat="12h" onChange={onChange} />
    )
    fireEvent.change(hour(), { target: { value: '9' } })
    fireEvent.change(minute(), { target: { value: '15' } })
    fireEvent.blur(minute())
    expect(onChange).toHaveBeenCalledWith('21:15') // 9 PM
  })
})
