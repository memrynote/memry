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
 *   * `probeEarlySent` / `probeLateSent` — the tiny probe envelopes, queued
 *     immediately before and immediately after `doc-load` (#2044). Present only
 *     while `setProbeEnabled(true)`, because unlike every other mark here they
 *     are not observations but two extra `injectJavaScript` calls, and a
 *     measurement that adds traffic to the channel it is measuring has no
 *     business running in an app nobody is measuring.
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
  | 'probeEarlySent'
  | 'docLoadSent'
  | 'probeLateSent'
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
  'idleTickFirst',
  'idleTickLast',
  'webviewMounted',
  'guestReady',
  'probeEarlySent',
  'probeEarlyRecv',
  'docLoadSent',
  'docLoadRecv',
  'probeLateSent',
  'probeLateRecv',
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

/**
 * What the `doc-load` for this open actually weighed (#2044).
 *
 * The three sizes are deliberately all kept rather than the first alone,
 * because the argument they settle is about which of them the crossing tracks.
 * `stateBytes` is the Y.Doc state, `wireChars` is its base64 form, and
 * `injectedChars` is the JavaScript source string WKWebView is finally asked to
 * evaluate — roughly twice the wire form, since the envelope is JSON-encoded
 * once and then escaped into a string literal a second time.
 */
export interface DocLoadPayload {
  stateBytes: number
  wireChars: number
  injectedChars: number
}

export interface OpenTrace {
  noteId: string
  startedAt: number
  /** Millisecond offsets from `startedAt`. */
  phases: Partial<Record<OpenPhase, number>>
  /** Absent until the host has sent a `doc-load` for this note. */
  payload?: DocLoadPayload
}

/**
 * Whether the host adds the #2044 probe envelopes to each open.
 *
 * Off by default and set by the harness for the length of a run. Every other
 * mark in this module is a `Date.now()` on work the app was doing anyway; these
 * two are extra crossings, and leaving them on would mean shipping a
 * measurement that changes the thing it measures.
 */
let probeEnabled = false

export function setProbeEnabled(enabled: boolean): void {
  probeEnabled = enabled
}

export function isProbeEnabled(): boolean {
  return probeEnabled
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

/**
 * Record what this note's `doc-load` weighed.
 *
 * Overwrites on a replay rather than accumulating: a resync sends the same
 * document again, and a second sample of one note's size would weight the
 * percentile by how often an open went wrong.
 */
export function markDocLoadPayload(noteId: string, payload: DocLoadPayload): void {
  const trace = live.get(noteId)
  if (!trace) return
  trace.payload = payload
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
  /** Sizes of the `doc-load` payloads this run sent (#2044). */
  payload: { field: keyof DocLoadPayload; samples: LatencySummary }[]
  /**
   * Named intervals, differenced PER TRACE.
   *
   * Not derivable from the phase table above it. Every phase there is
   * summarised over the traces that reached it, so two phases with different
   * sample counts have percentiles drawn from different opens, and subtracting
   * one p50 from the other is an arithmetic operation on two unrelated
   * populations. The crossing this issue is about is exactly such a pair —
   * `docLoadSent` is taken on every open and `docLoadRecv` only on the ones
   * that got there — so it has to be differenced before it is summarised.
   */
  intervals: { label: string; samples: LatencySummary }[]
}

/**
 * The pairs worth naming: the three crossings the probe experiment compares,
 * and the span they sit inside.
 */
const INTERVALS: readonly (readonly [OpenPhase, OpenPhase])[] = [
  ['probeEarlySent', 'probeEarlyRecv'],
  ['idleTickLast', 'docLoadRecv'],
  ['docLoadSent', 'docLoadRecv'],
  ['probeLateSent', 'probeLateRecv'],
  ['guestReady', 'painted']
]

const PAYLOAD_FIELDS: readonly (keyof DocLoadPayload)[] = [
  'stateBytes',
  'wireChars',
  'injectedChars'
]

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
  // The unit is a parameter because this report now carries two kinds of
  // number. Printing a byte count as `1184ms` is a caption that contradicts its
  // own table, and a reader who trusts the caption reads a payload size as a
  // latency.
  const line = (label: string, s: LatencySummary, unit: string): string =>
    `${label.padEnd(28)} n=${String(s.samples).padStart(3)}  p50=${s.p50}${unit}  p95=${s.p95}${unit}  max=${s.max}${unit}`

  return [
    `note-open latency — ${summary.traces} traces`,
    ...summary.phases.map((entry) => line(entry.phase, entry.samples, 'ms')),
    line('navigate→painted', summary.endToEnd, 'ms'),
    'intervals, differenced per trace',
    ...summary.intervals.map((entry) => line(entry.label, entry.samples, 'ms')),
    'doc-load payload size — stateBytes in bytes, the other two in characters',
    ...summary.payload.map((entry) => line(entry.field, entry.samples, ''))
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
    endToEnd: summarize(offsets('painted')),
    payload: PAYLOAD_FIELDS.map((field) => ({
      field,
      samples: summarize(traces.flatMap((trace) => (trace.payload ? [trace.payload[field]] : [])))
    })),
    intervals: INTERVALS.map(([from, to]) => ({
      label: `${from}→${to}`,
      samples: summarize(
        traces.flatMap((trace) => {
          const a = trace.phases[from]
          const b = trace.phases[to]
          // Both ends or neither. A trace that took only one of them contributes
          // nothing rather than a difference against a mark it never reached.
          return a !== undefined && b !== undefined ? [b - a] : []
        })
      )
    }))
  }
}
