import { summarize, type LatencySummary } from './latency'

/**
 * Note-open latency instrumentation for the launch-perf epic (#2026).
 *
 * WHAT IS BEING MEASURED, precisely, because the number is meaningless
 * otherwise: the span from the note screen's open effect firing to the note's
 * BODY being on screen. Not the route transition, which the navigator animates
 * over whatever the app is doing, and not the title, which paints from a
 * payload row long before the editor has a document. A rig that stopped at the
 * screen's first render would report a number the user never experiences.
 *
 * The phases split that span at the boundaries that can each be fixed
 * independently:
 *   * `navigate` — offset 0 by construction, so the end-to-end span is just
 *     the `painted` offset.
 *   * `sessionReady` — `getEditorSession`. Cold this opens the vault DB, reads
 *     keys out of the keychain and builds the outbox; warm it is a cached
 *     promise, so the two cases differ by orders of magnitude.
 *   * `docOpen` — the Y.Doc rebuilt from its SQLite snapshot plus updates.
 *     Scales with the note's edit history, not its length.
 *   * `recordRead` — the payload row behind the title and metadata.
 *   * `seedResolved` — the markdown fallback for a doc with no CRDT state. A
 *     local read, but it gates the first `doc-load`.
 *   * `webviewMounted` — WKWebView finished loading the inline HTML. The guest
 *     bundle's own parse and execute cost lands between here and `guestReady`.
 *   * `guestReady` — the `ready` handshake, which is when the host sends
 *     `doc-load`.
 *   * `painted` — the guest's frame callback after the document is laid out.
 *
 * Always on, never dev-gated, for the reason the keystroke recorder gives for
 * itself: a measurement path that only exists in a dev build measures a
 * different app than the one being gated. A mark costs one `Date.now()` and one
 * property write.
 */

export type OpenPhase =
  | 'navigate'
  | 'sessionReady'
  | 'docOpen'
  | 'recordRead'
  | 'seedResolved'
  | 'webviewMounted'
  | 'guestReady'
  | 'painted'

/** Ordered, so the reporter renders phases in sequence instead of each call site restating the order. */
export const OPEN_PHASES: readonly OpenPhase[] = [
  'navigate',
  'sessionReady',
  'docOpen',
  'recordRead',
  'seedResolved',
  'webviewMounted',
  'guestReady',
  'painted'
]

export interface OpenTrace {
  noteId: string
  startedAt: number
  /** Millisecond offsets from `startedAt`. */
  phases: Partial<Record<OpenPhase, number>>
}

/** Recent traces kept for the reporter; the buffer is the whole storage budget. */
const TRACE_CAPACITY = 64

const recent: OpenTrace[] = []

/** The trace each note id is currently marking into, so `mark` stays O(1). */
const live = new Map<string, OpenTrace>()

export function beginTrace(noteId: string): void {
  const trace: OpenTrace = { noteId, startedAt: Date.now(), phases: { navigate: 0 } }
  recent.push(trace)
  live.set(noteId, trace)

  while (recent.length > TRACE_CAPACITY) {
    const evicted = recent.shift()
    // Only when the map still points at THIS object: reopening the same note
    // has already replaced the entry, and deleting it would silence every mark
    // the newer trace has yet to take.
    if (evicted && live.get(evicted.noteId) === evicted) live.delete(evicted.noteId)
  }
}

/** A mark for a note with no open trace is dropped; an open nobody began is not an error. */
export function mark(noteId: string, phase: OpenPhase): void {
  const trace = live.get(noteId)
  if (!trace) return
  trace.phases[phase] = Date.now() - trace.startedAt
}

export function getTraces(): OpenTrace[] {
  return [...recent]
}

export function resetTraces(): void {
  recent.length = 0
  live.clear()
}

export interface OpenTraceSummary {
  traces: number
  phases: { phase: OpenPhase; samples: LatencySummary }[]
  /** `navigate` -> `painted`, the number the epic is judged by. */
  endToEnd: LatencySummary
}

/**
 * Plain-text baseline report, the counterpart of `formatG3Report`.
 *
 * The harness drives real navigation, so it does not survive its own run: the
 * push into the vault's tab tree takes the dev screen out of the stack and the
 * table it renders is unreachable by the time the numbers exist. Logging the
 * report is what makes the baseline readable at all — from `xcrun simctl spawn
 * booted log stream` on a simulator, and from the device log on hardware.
 */
export function formatOpenTraceReport(summary: OpenTraceSummary): string {
  const line = (label: string, s: LatencySummary): string =>
    `${label.padEnd(16)} n=${String(s.samples).padStart(3)}  p50=${s.p50}ms  p95=${s.p95}ms  max=${s.max}ms`

  return [
    `note-open latency — ${summary.traces} traces`,
    ...summary.phases.map((entry) => line(entry.phase, entry.samples)),
    line('navigate→painted', summary.endToEnd)
  ].join('\n')
}

export function summarizeOpenTraces(traces: OpenTrace[]): OpenTraceSummary {
  const offsets = (phase: OpenPhase): number[] => {
    const out: number[] = []
    for (const trace of traces) {
      const offset = trace.phases[phase]
      if (offset !== undefined) out.push(offset)
    }
    return out
  }

  return {
    traces: traces.length,
    phases: OPEN_PHASES.map((phase) => ({ phase, samples: summarize(offsets(phase)) })),
    // Painted traces only. An open that never reached the body is the worst
    // outcome there is, and letting it through as an absent sample would enter
    // it in the percentiles as the fastest one.
    endToEnd: summarize(offsets('painted'))
  }
}
