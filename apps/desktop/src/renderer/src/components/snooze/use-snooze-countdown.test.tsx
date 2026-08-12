import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSnoozeCountdown } from './use-snooze-countdown'

function Row({ until }: { until: Date | string | null }): React.JSX.Element {
  const countdown = useSnoozeCountdown(until)
  return <span data-testid="row">{countdown ?? 'none'}</span>
}

function Rows({ count, until }: { count: number; until: Date | string | null }): React.JSX.Element {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <Row key={i} until={until} />
      ))}
    </>
  )
}

let setIntervalSpy: ReturnType<typeof vi.spyOn>
let clearIntervalSpy: ReturnType<typeof vi.spyOn>
let addListenerSpy: ReturnType<typeof vi.spyOn>
let removeListenerSpy: ReturnType<typeof vi.spyOn>

/** Only the minute tick registers a 60s interval; ignore anything React schedules. */
const minuteIntervals = (): number =>
  setIntervalSpy.mock.calls.filter((call) => call[1] === 60000).length

const visibilityListeners = (spy: typeof addListenerSpy): number =>
  spy.mock.calls.filter((call) => call[0] === 'visibilitychange').length

describe('useSnoozeCountdown shared tick', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-10T09:00:00.000Z'))
    setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
    addListenerSpy = vi.spyOn(document, 'addEventListener')
    removeListenerSpy = vi.spyOn(document, 'removeEventListener')
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('creates one interval and one visibilitychange listener for many rows', () => {
    render(<Rows count={50} until="2026-05-10T10:00:00.000Z" />)

    expect(screen.getAllByTestId('row')).toHaveLength(50)
    expect(minuteIntervals()).toBe(1)
    expect(visibilityListeners(addListenerSpy)).toBe(1)
  })

  it('keeps the shared tick alive until the last row unmounts', () => {
    const { rerender, unmount } = render(<Rows count={3} until="2026-05-10T10:00:00.000Z" />)

    rerender(<Rows count={1} until="2026-05-10T10:00:00.000Z" />)
    expect(clearIntervalSpy).not.toHaveBeenCalled()
    expect(visibilityListeners(removeListenerSpy)).toBe(0)

    unmount()
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1)
    expect(visibilityListeners(removeListenerSpy)).toBe(1)

    // A later row starts a fresh tick rather than reusing a dead one.
    render(<Rows count={1} until="2026-05-10T10:00:00.000Z" />)
    expect(minuteIntervals()).toBe(2)
  })

  it('never starts the clock for rows without a snooze', () => {
    render(<Rows count={5} until={null} />)

    expect(screen.getAllByTestId('row')[0]).toHaveTextContent('none')
    expect(minuteIntervals()).toBe(0)
    expect(visibilityListeners(addListenerSpy)).toBe(0)
  })

  it('updates every row on each shared minute tick', () => {
    render(<Rows count={3} until="2026-05-10T10:00:00.000Z" />)
    for (const row of screen.getAllByTestId('row')) {
      expect(row).toHaveTextContent('1h left')
    }

    act(() => {
      vi.advanceTimersByTime(60000)
    })
    for (const row of screen.getAllByTestId('row')) {
      expect(row).toHaveTextContent('59m left')
    }
  })

  it('refreshes rows when the app returns to the foreground', () => {
    render(<Rows count={2} until="2026-05-10T10:00:00.000Z" />)
    expect(screen.getAllByTestId('row')[0]).toHaveTextContent('1h left')

    // Background throttling: the clock moved on without the interval firing.
    act(() => {
      vi.setSystemTime(new Date('2026-05-10T09:30:00.000Z'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    for (const row of screen.getAllByTestId('row')) {
      expect(row).toHaveTextContent('30m left')
    }
  })
})
