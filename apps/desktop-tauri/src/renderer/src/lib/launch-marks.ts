// The renderer half of the launch timings: paint, navigation and the note-readable mark, sent
// once to `main.log` (`launch_report_renderer_marks`), where `scripts/launch-bench.mjs` reads
// them next to the shell's `launch timeline {` block.
import { commands, type RendererLaunchMarks } from '../../../generated/bindings'
import { NOTE_READABLE_MARK } from './launch-restore'
import { createLogger } from './logger'

const log = createLogger('LaunchMarks')

/** How long after `load` a launch that restored no note waits for the note-readable mark. */
export const NOTE_READABLE_WAIT_MS = 8_000

const round = (value: number | undefined): number | null =>
  typeof value === 'number' ? Math.round(value * 1000) / 1000 : null

export const readLaunchMarks = (): RendererLaunchMarks => {
  const navigation = performance
    .getEntriesByType('navigation')
    .find((entry): entry is PerformanceNavigationTiming => 'domInteractive' in entry)
  const paints = performance.getEntriesByType('paint')
  const paintAt = (name: string): number | undefined =>
    paints.find((entry) => entry.name === name)?.startTime
  return {
    firstPaintMs: round(paintAt('first-paint')),
    fcpMs: round(paintAt('first-contentful-paint')),
    domInteractiveMs: round(navigation?.domInteractive),
    domContentLoadedMs: round(navigation?.domContentLoadedEventEnd),
    noteReadableMs: round(performance.getEntriesByName(NOTE_READABLE_MARK)[0]?.startTime)
  }
}

/** Reports once: when the note-readable mark lands, else `NOTE_READABLE_WAIT_MS` after `load`. */
export function reportLaunchMarks(): void {
  let reported = false
  let observer: PerformanceObserver | undefined
  const report = (): void => {
    if (reported) return
    reported = true
    observer?.disconnect()
    commands
      .launchReportRendererMarks(readLaunchMarks())
      .catch((error: unknown) => log.warn('launch_report_renderer_marks failed', error))
  }

  try {
    observer = new PerformanceObserver((list) => {
      if (list.getEntriesByName(NOTE_READABLE_MARK).length > 0) report()
    })
    observer.observe({ type: 'mark', buffered: true })
  } catch (error) {
    // The timer below still reports, with whatever the page recorded by then.
    log.warn('no performance observer for the note-readable mark', error)
  }

  const armTimer = (): void => {
    setTimeout(report, NOTE_READABLE_WAIT_MS)
  }
  if (document.readyState === 'complete') armTimer()
  else window.addEventListener('load', armTimer, { once: true })
}
