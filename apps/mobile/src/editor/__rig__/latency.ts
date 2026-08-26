import type { BridgeCounters } from '@memry/contracts/webview-bridge'
import { BRIDGE_T_FLUSH_MS, MSGS_PER_ENVELOPE_BUCKETS } from '@memry/contracts/webview-bridge'
import type { EditorBridgeProvider } from '../bridge-provider'

/**
 * Keystroke-latency instrumentation for the G3 measurement (T074/T075).
 *
 * WHAT IS BEING MEASURED, precisely, because the number is meaningless
 * otherwise: the WebView renders its own keystroke locally, so the bridge is
 * off the critical render path by design. The <50 ms p95 budget therefore gates
 * the END-TO-END ECHO — keystroke → RN-owned doc → durable → ack — plus any
 * render stall caused by bridge back-pressure. A rig that timed the local
 * character appearing would report ~0 ms and prove nothing.
 *
 * Two samples per edit, kept apart because they fail for different reasons:
 *   * DELIVERY — WebView flush to RN receipt. Grows with envelope size and
 *     WKWebView messaging cost.
 *   * PERSIST — RN receipt to SQLite commit (the durability rule's own cost).
 *     Grows with doc size and disk pressure.
 */

export interface LatencySummary {
  samples: number
  p50: number
  p95: number
  p99: number
  max: number
}

export interface G3Measurement {
  /** WebView flush → RN receipt. */
  delivery: LatencySummary
  /** RN receipt → durable in SQLite. */
  persist: LatencySummary
  /** The budgeted number: delivery + persist for the same edit. */
  endToEnd: LatencySummary
  counters: BridgeCounters
  /** msgs-per-RECEIVED-envelope, as a readable histogram; the proof (T075). */
  batching: { bucket: string; envelopes: number }[]
  /** Mean messages per envelope; must exceed 1 under a real typing burst. */
  msgsPerEnvelope: number
  /** True when every G3 threshold below is met. */
  pass: boolean
  failures: string[]
}

/** The budget from the contract, on the reference mid-tier device. */
export const G3_END_TO_END_P95_MS = 50

function summarize(samples: number[]): LatencySummary {
  if (samples.length === 0) return { samples: 0, p50: 0, p95: 0, p99: 0, max: 0 }
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
  return {
    samples: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1]
  }
}

/**
 * Records one edit's journey. `onReceived` is called when the envelope lands,
 * `onPersisted` when `appendLocalUpdate` has committed — so the pair brackets
 * exactly the work the budget covers.
 */
export class LatencyRecorder {
  private persist: number[] = []
  private endToEnd: number[] = []

  constructor(private readonly bridge: EditorBridgeProvider) {}

  reset(): void {
    this.persist = []
    this.endToEnd = []
    this.bridge.resetCounters()
  }

  /**
   * Time one persisted update. `deliveryMs` is the envelope's own delivery
   * latency, which the caller reads from the envelope that carried it — a
   * recorder that re-derived it would be timing a different envelope.
   */
  async record<T>(deliveryMs: number, persist: () => Promise<T>): Promise<T> {
    const startedAt = Date.now()
    try {
      return await persist()
    } finally {
      const persistMs = Date.now() - startedAt
      this.persist.push(persistMs)
      this.endToEnd.push(deliveryMs + persistMs)
    }
  }

  summary(): G3Measurement {
    const counters = this.bridge.getCounters()
    const delivery = summarize(this.bridge.getDeliverySamples())
    const persist = summarize(this.persist)
    const endToEnd = summarize(this.endToEnd)

    // RECEIVED, not sent. The batching G3 gates is the WebView's coalescing of
    // keystroke updates; the sent histogram counts RN→WebView traffic and
    // would report ~1.00 forever, printing a permanent false FAIL.
    const envelopes = counters.envelopesReceived
    const msgsPerEnvelope = envelopes === 0 ? 0 : counters.msgsReceived / envelopes

    const failures: string[] = []
    if (endToEnd.samples === 0) {
      failures.push('no samples recorded')
    } else if (endToEnd.p95 > G3_END_TO_END_P95_MS) {
      failures.push(
        `end-to-end p95 ${endToEnd.p95} ms exceeds the ${G3_END_TO_END_P95_MS} ms budget`
      )
    }
    if (counters.seqGaps > 0) failures.push(`${counters.seqGaps} envelope sequence gaps`)
    // The batching proof G0-d could not produce: at 10 keystrokes/s the 24 ms
    // window never coalesces, which is arithmetic, not a defect. Real Yjs
    // update clusters arrive faster than T_flush, so this is where the claim is
    // actually testable.
    if (envelopes > 0 && msgsPerEnvelope <= 1) {
      failures.push(
        `msgs/envelope ${msgsPerEnvelope.toFixed(2)} — no coalescing observed at T_flush=${BRIDGE_T_FLUSH_MS} ms`
      )
    }

    return {
      delivery,
      persist,
      endToEnd,
      counters,
      batching: histogram(counters),
      msgsPerEnvelope,
      pass: failures.length === 0,
      failures
    }
  }
}

export function histogram(counters: BridgeCounters): { bucket: string; envelopes: number }[] {
  const labels = ['1', '2', '3-4', '5-8', '9+']
  return MSGS_PER_ENVELOPE_BUCKETS.map((_, index) => ({
    bucket: labels[index] ?? `${index}`,
    envelopes: counters.msgsPerEnvelopeReceived[index] ?? 0
  }))
}

/** Plain-text report for the G3 evidence bundle (T077). */
export function formatG3Report(measurement: G3Measurement): string {
  const line = (label: string, s: LatencySummary): string =>
    `${label.padEnd(12)} n=${String(s.samples).padStart(5)}  p50=${s.p50}ms  p95=${s.p95}ms  p99=${s.p99}ms  max=${s.max}ms`

  return [
    `G3 keystroke latency — budget: end-to-end p95 < ${G3_END_TO_END_P95_MS} ms`,
    line('delivery', measurement.delivery),
    line('persist', measurement.persist),
    line('end-to-end', measurement.endToEnd),
    '',
    `envelopes received: ${measurement.counters.envelopesReceived}  msgs received: ${measurement.counters.msgsReceived}`,
    `envelopes sent: ${measurement.counters.envelopesSent}  msgs sent: ${measurement.counters.msgsSent}`,
    `msgs/envelope: ${measurement.msgsPerEnvelope.toFixed(2)} (must exceed 1.00)`,
    `seq gaps: ${measurement.counters.seqGaps}  resyncs: ${measurement.counters.resyncs}`,
    ...measurement.batching.map((row) => `  msgs/envelope ${row.bucket}: ${row.envelopes}`),
    '',
    measurement.pass ? 'PASS' : `FAIL — ${measurement.failures.join('; ')}`
  ].join('\n')
}
