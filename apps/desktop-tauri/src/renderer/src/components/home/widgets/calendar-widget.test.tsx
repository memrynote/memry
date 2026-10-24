import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { CalendarWidget } from './calendar-widget'
import { CalendarHeaderCount, CalendarFooter } from './calendar-header'
import { localDayRange } from '@/lib/local-day-range'

// Expected through the helper the components use, not as literal instants: the range is the local
// day, so its UTC form moves with the machine's zone (#1920).
const AUG_12 = localDayRange('2026-08-12')
const AUG_13 = localDayRange('2026-08-13')

// Every range the components ask for, in order — the assertion target: after midnight the widget
// must query the new day instead of staying pinned to the range it computed at mount.
let requestedRanges: Array<{ startAt: string; endAt: string }> = []

vi.mock('@/hooks/use-calendar-range', () => ({
  useCalendarRange: (input: { startAt: string; endAt: string }) => {
    requestedRanges.push(input)
    return { items: [], isLoading: false, error: null }
  }
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: { clockFormat: '24h' } })
}))

vi.mock('@/contexts/tabs', () => ({
  useTabActions: () => ({ openTab: vi.fn() })
}))

function lastRange(): { startAt: string; endAt: string } {
  return requestedRanges[requestedRanges.length - 1]
}

describe('calendar widget midnight rollover', () => {
  beforeEach(() => {
    requestedRanges = []
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 12, 23, 59, 30, 0))
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('queries the new day after local midnight without a remount', () => {
    render(<CalendarWidget config={{}} size="M" />)
    expect(lastRange()).toEqual(AUG_12)

    act(() => {
      vi.advanceTimersByTime(30_000)
    })

    expect(lastRange()).toEqual(AUG_13)
  })

  it('keeps the header count on the same day as the widget body after rollover', () => {
    render(<CalendarHeaderCount />)
    expect(lastRange().startAt).toBe(AUG_12.startAt)

    act(() => {
      vi.advanceTimersByTime(30_000)
    })

    expect(lastRange().startAt).toBe(AUG_13.startAt)
  })

  it('rolls the footer range over too', () => {
    render(<CalendarFooter />)
    expect(lastRange().startAt).toBe(AUG_12.startAt)

    act(() => {
      vi.advanceTimersByTime(30_000)
    })

    expect(lastRange().startAt).toBe(AUG_13.startAt)
  })

  it('keeps the range stable while the day has not changed', () => {
    render(<CalendarWidget config={{}} size="M" />)
    const before = lastRange()

    act(() => {
      vi.advanceTimersByTime(20_000)
    })

    expect(lastRange()).toEqual(before)
  })
})
