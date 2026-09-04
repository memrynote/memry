import { GUEST_PAINT_MARKS, type GuestPaintMark } from '@memry/contracts/webview-bridge'
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
 *   * `docLoadSent` — the host's `doc-load` is on the wire. Paired with the
 *     guest's `docLoadRecv`, it splits the interval that turned out to hold
 *     almost the entire open (#2043) into the host's own work and the crossing,
 *     which are different defects with different fixes.
 *   * `painted` — the guest's frame callback after the document is laid out.
 *
 * Between `webviewMounted` and `painted` sit the GUEST's own sub-marks (#2043),
 * which carry the same names the contract declares in `GUEST_PAINT_MARKS`. They
 * are ordinary phases here on purpose. The #2026 baseline left 3390 ms of a
 * 3876 ms open inside one interval, and a reviewer asked to align a host table
 * against a separate guest table reads neither; a phase is a phase, whichever
 * side of the bridge took it.
 *
 * Always on, never dev-gated, for the reason the keystroke recorder gives for
 * itself: a measurement path that only exists in a dev build measures a
 * different app than the one being gated. A mark costs one `Date.now()` and one
 * property write.
 */

export type OpenHostPhase =
  | 'navigate'
  | 'sessionReady'
  | 'docOpen'
  | 'recordRead'
  | 'seedResolved'
  | 'webviewMounted'
  | 'guestReady'
  | 'docLoadSent'
  | 'painted'

export type OpenPhase = OpenHostPhase | GuestPaintMark

/**
 * Ordered, so the reporter renders phases in sequence instead of each call site
 * restating the order.
 *
 * DECLARED order, not sorted by measurement: a guest mark that lands out of
 * sequence is a finding — a clock the two sides disagree about, or a `doc-load`
 * replayed after the paint — and sorting the table by its own numbers is
 * exactly what would hide it.
 */
export const OPEN_PHASES: readonly OpenPhase[] = [
  'navigate',
  'sessionReady',
  'docOpen',
  'recordRead',
  'seedResolved',
  'docStart',
  'importsStart',
  'scriptEval',
  'schemaBuilt',
  'readySent',
  'webviewMounted',
  'guestReady',
  'docLoadSent',
  'docLoadRecv',
  'yApplied',
  'createStart',
  'createEnd',
  'mountEnd',
  'shikiStart',
  'shikiSync',
  'shikiEnd',
  'seedEnd',
  'guestPainted',
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

/**
 * Fold the guest's sub-marks into this note's trace (#2043).
 *
 * The guest reports ABSOLUTE epoch stamps and they are rebased here, because
 * the guest has no idea when the host's trace started — the WebView is created
 * well after `navigate`. Both ends read the same device wall clock, which is
 * the same assumption the envelope's `sentAt` already rests on.
 *
 * A mark the guest never took is absent, and stays absent. Substituting a zero
 * would enter a phase that never happened as the FASTEST sample in its own
 * percentile, which is the one lie a latency table must not tell.
 */
export function markGuestPhases(
  noteId: string,
  marks: Partial<Record<GuestPaintMark, number>> | undefined
): void {
  if (!marks) return
  const trace = live.get(noteId)
  if (!trace) return
  for (const phase of GUEST_PAINT_MARKS) {
    const epoch = marks[phase]
    if (epoch !== undefined) trace.phases[phase] = epoch - trace.startedAt
  }
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
