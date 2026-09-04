import { afterEach, describe, expect, it } from 'vitest'
import {
  beginTrace,
  formatOpenTraceReport,
  getTraces,
  mark,
  markGuestPhases,
  resetTraces,
  summarizeOpenTraces
} from '../__rig__/open-trace'

/**
 * A warm open reaches none of the guest's BOOT marks: the WebView is created
 * once for the whole notes stack (#2030), so `docStart` and its neighbours
 * belong to the first open and are absent from every one after it.
 *
 * That makes the report's treatment of an absent phase load-bearing.
 * `summarize([])` answers zero for every percentile, and printing that as
 * `p50=0ms` enters a phase that never happened as the fastest sample in its
 * own table — which is the one lie a latency table must not tell.
 */

describe('open trace report', () => {
  afterEach(() => resetTraces())

  it('prints a phase no trace reached as absent rather than instant', () => {
    // A cold open: the WebView booted for it, so it has the boot marks.
    beginTrace('note-cold')
    markGuestPhases('note-cold', { docStart: Date.now(), guestPainted: Date.now() })
    mark('note-cold', 'painted')

    // A warm open on the same WebView. Its guest reports its own marks only.
    beginTrace('note-warm')
    markGuestPhases('note-warm', { guestPainted: Date.now() })
    mark('note-warm', 'painted')

    const report = formatOpenTraceReport(summarizeOpenTraces(getTraces()))
    const row = (phase: string): string =>
      report.split('\n').find((line) => line.startsWith(phase)) ?? ''

    // Taken by one of the two opens, so it is a real number over one sample.
    expect(row('docStart')).toMatch(/n=\s*1\s+p50=\d+ms/)
    // Taken by both.
    expect(row('guestPainted')).toMatch(/n=\s*2\s+p50=\d+ms/)
    // Taken by neither. `p50=0ms` here would report the fastest open in the
    // run as one that never happened.
    expect(row('schemaBuilt')).toMatch(/n=\s*0\s+p50=-\s+p95=-\s+max=-/)
    expect(row('schemaBuilt')).not.toContain('0ms')
  })

  it('still prints payload sizes without a unit', () => {
    beginTrace('note-1')
    mark('note-1', 'painted')

    const report = formatOpenTraceReport(summarizeOpenTraces(getTraces()))
    // No `doc-load` was sent, so every size row is absent too — and a byte
    // count of `-` is honest where `0` would read as an empty document.
    expect(report).toMatch(/stateBytes\s+n=\s*0\s+p50=-/)
  })
})
