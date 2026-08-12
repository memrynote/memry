import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const HOUR_MS = 60 * 60 * 1000

// Vitest workers ignore a runtime `process.env.TZ` assignment, so these tests cannot pin a
// DST-observing zone. Instead they assert against the runtime's own local-midnight boundaries,
// which stays meaningful in every zone: a day is 23h/25h long where DST applies and 24h where it
// does not, and either way the rollover must land on local 00:00.
function localDayLengthMs(year: number, monthIndex: number, day: number): number {
  const start = new Date(year, monthIndex, day, 0, 0, 0, 0)
  const next = new Date(year, monthIndex, day + 1, 0, 0, 0, 0)
  return next.getTime() - start.getTime()
}

// The store keeps module-level state (current day, shared timer, listener set), so each test gets
// a fresh module after the system clock is set.
async function loadUseToday(): Promise<() => string> {
  vi.resetModules()
  const mod = await import('./use-today')
  return mod.useToday
}

function makeProbe(useToday: () => string) {
  return function Probe({ label = 'today' }: { label?: string }): React.JSX.Element {
    return <span data-testid={label}>{useToday()}</span>
  }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useToday', () => {
  it('rolls over to the new local day at midnight without a remount', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 12, 23, 59, 0, 0))
    const useToday = await loadUseToday()
    const Probe = makeProbe(useToday)

    render(<Probe />)
    expect(screen.getByTestId('today').textContent).toBe('2026-08-12')

    act(() => {
      vi.advanceTimersByTime(59_999)
    })
    expect(screen.getByTestId('today').textContent).toBe('2026-08-12')

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.getByTestId('today').textContent).toBe('2026-08-13')
  })

  it('re-arms after firing so the following midnight also rolls over', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 12, 23, 59, 59, 0))
    const useToday = await loadUseToday()
    const Probe = makeProbe(useToday)

    render(<Probe />)

    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(screen.getByTestId('today').textContent).toBe('2026-08-13')

    act(() => {
      vi.advanceTimersByTime(24 * HOUR_MS)
    })
    expect(screen.getByTestId('today').textContent).toBe('2026-08-14')
  })

  it('schedules to the next local midnight rather than 24h from mount', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 12, 9, 0, 0, 0))
    const useToday = await loadUseToday()
    const Probe = makeProbe(useToday)

    render(<Probe />)
    expect(screen.getByTestId('today').textContent).toBe('2026-08-12')

    const untilMidnight = new Date(2026, 7, 13, 0, 0, 0, 0).getTime() - Date.now()
    act(() => {
      vi.advanceTimersByTime(untilMidnight - 1)
    })
    expect(screen.getByTestId('today').textContent).toBe('2026-08-12')

    // A `now + 24h` timer would still be pending here, leaving yesterday on screen until 09:00.
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.getByTestId('today').textContent).toBe('2026-08-13')
  })

  it.each([
    { label: 'spring-forward', year: 2026, monthIndex: 2, day: 8, next: '2026-03-09' },
    { label: 'fall-back', year: 2026, monthIndex: 10, day: 1, next: '2026-11-02' }
  ])(
    'lands on local midnight on a $label transition date',
    async ({ year, monthIndex, day, next }) => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(year, monthIndex, day, 0, 0, 0, 0))
      const useToday = await loadUseToday()
      const Probe = makeProbe(useToday)

      render(<Probe />)

      // 23h, 24h or 25h depending on the runtime zone — the timer must follow the calendar, not a
      // hardcoded day length.
      const dayLength = localDayLengthMs(year, monthIndex, day)
      act(() => {
        vi.advanceTimersByTime(dayLength - 1)
      })
      expect(screen.getByTestId('today').textContent).not.toBe(next)

      act(() => {
        vi.advanceTimersByTime(1)
      })
      expect(screen.getByTestId('today').textContent).toBe(next)
    }
  )

  it('re-syncs on window focus when the clock jumped past midnight while suspended', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 12, 23, 30, 0, 0))
    const useToday = await loadUseToday()
    const Probe = makeProbe(useToday)

    render(<Probe />)
    expect(screen.getByTestId('today').textContent).toBe('2026-08-12')

    // Sleep/wake and system clock changes move the wall clock without running pending timers.
    vi.setSystemTime(new Date(2026, 7, 14, 9, 0, 0, 0))
    expect(screen.getByTestId('today').textContent).toBe('2026-08-12')

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(screen.getByTestId('today').textContent).toBe('2026-08-14')
  })

  it('re-syncs when the document becomes visible again', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 12, 23, 30, 0, 0))
    const useToday = await loadUseToday()
    const Probe = makeProbe(useToday)

    render(<Probe />)
    expect(screen.getByTestId('today').textContent).toBe('2026-08-12')

    vi.setSystemTime(new Date(2026, 7, 13, 8, 0, 0, 0))
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(screen.getByTestId('today').textContent).toBe('2026-08-13')
  })

  it('shares one timer across consumers and rolls them over together', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 12, 23, 59, 59, 0))
    const useToday = await loadUseToday()
    const Probe = makeProbe(useToday)

    render(
      <>
        <Probe label="a" />
        <Probe label="b" />
        <Probe label="c" />
      </>
    )
    expect(vi.getTimerCount()).toBe(1)

    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(screen.getByTestId('a').textContent).toBe('2026-08-13')
    expect(screen.getByTestId('b').textContent).toBe('2026-08-13')
    expect(screen.getByTestId('c').textContent).toBe('2026-08-13')
  })

  it('clears the timer and its listeners when the last consumer unmounts', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 12, 12, 0, 0, 0))
    const useToday = await loadUseToday()
    const Probe = makeProbe(useToday)

    const { unmount } = render(
      <>
        <Probe label="a" />
        <Probe label="b" />
      </>
    )
    expect(vi.getTimerCount()).toBe(1)

    unmount()
    expect(vi.getTimerCount()).toBe(0)

    // Listeners are gone too, so a resume event cannot re-arm an orphaned timer.
    act(() => {
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the timer armed while at least one consumer is still mounted', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 12, 23, 59, 59, 0))
    const useToday = await loadUseToday()
    const Probe = makeProbe(useToday)

    const first = render(<Probe label="a" />)
    render(<Probe label="b" />)
    expect(vi.getTimerCount()).toBe(1)

    first.unmount()
    expect(vi.getTimerCount()).toBe(1)

    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(screen.getByTestId('b').textContent).toBe('2026-08-13')
  })
})
