import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { reportMarks } = vi.hoisted(() => ({
  reportMarks: vi.fn((_marks: unknown) => Promise.resolve(null))
}))
vi.mock('../../../generated/bindings', () => ({
  commands: { launchReportRendererMarks: reportMarks }
}))
vi.mock('./launch-restore', () => ({ NOTE_READABLE_MARK: 'memry:note-readable' }))

import { NOTE_READABLE_WAIT_MS, reportLaunchMarks } from './launch-marks'

type Entry = { name: string; startTime: number }

// jsdom records no paint or navigation entries and has no PerformanceObserver: both are the
// web view's, so the test stands them in.
let entries: Record<string, Entry[]>
let observed: ((list: { getEntriesByName: (name: string) => Entry[] }) => void) | null

class FakeObserver {
  constructor(callback: NonNullable<typeof observed>) {
    observed = callback
  }
  observes = 0
  observe(): void {
    this.observes += 1
  }
  disconnect(): void {
    observed = null
  }
}

const markNoteReadable = (startTime: number): void => {
  const mark = { name: 'memry:note-readable', startTime }
  entries.mark = [mark]
  observed?.({ getEntriesByName: (name) => (name === mark.name ? [mark] : []) })
}

describe('reportLaunchMarks', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    observed = null
    entries = {
      paint: [
        { name: 'first-paint', startTime: 120.4567 },
        { name: 'first-contentful-paint', startTime: 130 }
      ],
      navigation: [
        { name: 'nav', startTime: 0, domInteractive: 80, domContentLoadedEventEnd: 95 } as Entry
      ],
      mark: []
    }
    vi.stubGlobal('PerformanceObserver', FakeObserver)
    vi.spyOn(performance, 'getEntriesByType').mockImplementation(
      (type: string) => (entries[type] ?? []) as PerformanceEntryList
    )
    vi.spyOn(performance, 'getEntriesByName').mockImplementation(
      (name: string) => entries.mark.filter((entry) => entry.name === name) as PerformanceEntryList
    )
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    reportMarks.mockClear()
  })

  it('reports once when the note-readable mark lands', async () => {
    reportLaunchMarks()
    expect(reportMarks).not.toHaveBeenCalled()

    markNoteReadable(640.25)
    markNoteReadable(900)
    await vi.advanceTimersByTimeAsync(NOTE_READABLE_WAIT_MS * 2)

    expect(reportMarks).toHaveBeenCalledTimes(1)
    expect(reportMarks).toHaveBeenCalledWith({
      firstPaintMs: 120.457,
      fcpMs: 130,
      domInteractiveMs: 80,
      domContentLoadedMs: 95,
      noteReadableMs: 640.25
    })
  })

  it('reports without the mark once the wait after load has passed', async () => {
    reportLaunchMarks()
    await vi.advanceTimersByTimeAsync(NOTE_READABLE_WAIT_MS - 1)
    expect(reportMarks).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(reportMarks).toHaveBeenCalledTimes(1)
    expect(reportMarks.mock.calls[0]?.[0]).toMatchObject({ fcpMs: 130, noteReadableMs: null })

    markNoteReadable(9000)
    expect(reportMarks).toHaveBeenCalledTimes(1)
  })

  it('still reports on the timer when the web view has no observer', async () => {
    vi.stubGlobal('PerformanceObserver', undefined)
    reportLaunchMarks()
    await vi.advanceTimersByTimeAsync(NOTE_READABLE_WAIT_MS)
    expect(reportMarks).toHaveBeenCalledTimes(1)
  })
})
