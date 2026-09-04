import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router, useLocalSearchParams } from 'expo-router'
import { File, Paths } from 'expo-file-system'
import { ThemedText } from '@/components/themed-text'
import { ThemedView } from '@/components/themed-view'
import { Spacing } from '@/constants/theme'
import {
  formatOpenTraceReport,
  getTraces,
  resetTraces,
  setProbeEnabled,
  summarizeOpenTraces,
  type OpenTrace,
  type OpenTraceSummary
} from '@/editor/__rig__/open-trace'
import { EDITOR_WEB_CONTRACT_HASH } from '@/editor/editor-web-asset'
import { getEditorSession } from '@/editor/session'
import type { VaultDb } from '@/db'
import { readNotesSnapshot } from '@/features/notes/notes-repo'
import { createLogger } from '@/lib/logger'
import { loadCurrentVaultId } from '@/sync/auth-client'

/**
 * Note-open latency harness for epic #2025, issue #2026.
 *
 * It drives the REAL router rather than calling the open path itself: the whole
 * point of the baseline is to time what a tap costs, and a reimplementation
 * would silently exclude the navigator, the screen's mount and the WebView's
 * own startup — which is most of what the epic is about.
 */

/** Enough iterations for a believable p95 without the run outlasting patience. */
const DEFAULT_ITERATIONS = 20

const POLL_INTERVAL_MS = 25

/** A cold open on a slow device is seconds, not milliseconds; this only bounds a hang. */
const PAINT_TIMEOUT_MS = 8_000

/** The back-navigation and the unmount it triggers must finish before the next push. */
const SETTLE_MS = 350

const log = createLogger('OpenTraceRig')

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const REPORT_FILE = 'open-trace-report.txt'

/**
 * Drop the finished report where it can be read off the device.
 *
 * The table on screen is twenty-odd phases and does not fit one viewport, and a
 * simulator offers no way to scroll it — so the numbers this rig exists to
 * produce were, in practice, unreadable. `console.warn` does not reach
 * `simctl log stream` from Hermes either. A file in the document directory is
 * the one sink the host can just `cat`.
 *
 * Best-effort by construction: a run that produced numbers and failed to write
 * them down still has them on screen and in the ring.
 */
function writeReport(text: string): string | null {
  try {
    const file = new File(Paths.document, REPORT_FILE)
    file.create({ overwrite: true })
    file.write(text)
    return file.uri
  } catch (err) {
    log.warn('Could not write the open-trace report', {
      error: err instanceof Error ? err.message : String(err)
    })
    return null
  }
}

/** How many notes either end of the length ordering contributes. */
const SIZE_POOL = 20

/**
 * Notes at one end of the body-length ordering, longest or shortest first
 * (#2043).
 *
 * The breakdown has to say which of the guest's costs scale with content and
 * which are flat, and the default pool cannot answer that: it is ordered by
 * `updated_at`, so a run over it mixes every length together and averages the
 * signal away. Two runs over the two ends give the pair of numbers the question
 * actually asks for.
 *
 * `note_bodies.markdown` is the length that matters here rather than the Y.Doc
 * snapshot: it is the content the guest lays out. The snapshot's size tracks
 * edit HISTORY, so a heavily-revised one-line note would sort as long.
 */
async function readNotesBySize(
  db: VaultDb,
  longest: boolean
): Promise<{ id: string; len: number }[]> {
  return db.getAllAsync<{ id: string; len: number }>(
    `SELECT s.id AS id, length(b.markdown) AS len
       FROM sync_items s
       JOIN note_bodies b ON b.item_id = s.id
      WHERE s.type = 'note' AND s.deleted_at IS NULL AND s.payload_state = 'full'
        AND length(b.markdown) > 0
      ORDER BY len ${longest ? 'DESC' : 'ASC'}
      LIMIT ${SIZE_POOL}`
  )
}

/**
 * The `painted` offset for this iteration's open, or `null` if it never landed.
 *
 * `startedAt >= since` matters: the ring still holds this note's earlier opens,
 * so matching on the id alone would return a previous iteration's finished
 * trace immediately and report a run of zeroes.
 */
async function waitForPaint(noteId: string, since: number): Promise<number | null> {
  const deadline = Date.now() + PAINT_TIMEOUT_MS
  while (Date.now() < deadline) {
    for (const trace of getTraces()) {
      if (trace.noteId !== noteId || trace.startedAt < since) continue
      const painted = trace.phases.painted
      if (painted !== undefined) return painted
    }
    await delay(POLL_INTERVAL_MS)
  }
  return null
}

interface RunOptions {
  total: number
  /** Which end of the body-length ordering to open, or the default pool. */
  sizeEnd: 'short' | 'long' | null
  /**
   * Add the #2044 probe envelopes. Off unless asked for: they are two extra
   * crossings per open, so a run with them on is not comparable to the #2043
   * baseline and must not be mistaken for one.
   */
  probe: boolean
}

export default function OpenTraceScreen() {
  const params = useLocalSearchParams<{
    autorun?: string
    n?: string
    size?: string
    probe?: string
  }>()
  const size = params.size === 'long' || params.size === 'short' ? params.size : null
  const probe = params.probe === '1'
  const requested = Number.parseInt(params.n ?? '', 10)
  const iterations = Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_ITERATIONS
  const autorun = params.autorun === '1'

  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  // Rendered from the trace ring, not from run-local state: pushing into the
  // vault's tab tree takes this screen out of the stack, so the run finishes
  // with nothing mounted to hold its results. Re-entering the screen after a
  // run reads the same ring and shows the numbers.
  const [traces, setTraces] = useState<OpenTrace[]>(() => getTraces())

  const run = useCallback(async (opts: RunOptions) => {
    const { total, sizeEnd, probe } = opts
    setRunning(true)
    setStatus(null)
    setTraces([])
    setProbeEnabled(probe)
    try {
      const vaultId = await loadCurrentVaultId()
      if (!vaultId) {
        setStatus('Not signed into a vault — there is nothing to open.')
        return
      }
      const session = await getEditorSession(vaultId)

      let ids: string[]
      let pool: string
      if (sizeEnd) {
        const rows = await readNotesBySize(session.db, sizeEnd === 'long')
        ids = rows.map((row) => row.id)
        pool =
          rows.length > 0
            ? `${sizeEnd} pool: ${rows.length} notes, ${Math.min(...rows.map((r) => r.len))}–${Math.max(...rows.map((r) => r.len))} chars`
            : `${sizeEnd} pool is empty`
      } else {
        const snapshot = await readNotesSnapshot(session.db)
        // Notes with a body first: an empty note skips the seed probe and most
        // of the guest's parse work, so timing those would flatter the
        // baseline.
        const withBody = snapshot.entries.filter((entry) => entry.hasBody)
        ids = (withBody.length > 0 ? withBody : snapshot.entries).map((entry) => entry.id)
        pool = `default pool: ${ids.length} notes, unordered by length`
      }
      if (ids.length === 0) {
        setStatus('This vault has no notes.')
        return
      }
      log.warn(pool)
      setStatus(pool)

      resetTraces()
      for (let i = 0; i < total; i++) {
        setProgress({ done: i, total })
        // Consecutive iterations open DIFFERENT notes, so the doc manager's
        // cache is not what is being measured on every run but the first.
        const noteId = ids[i % ids.length]
        const pushedAt = Date.now()
        router.push(`/notes/${noteId}`)
        const painted = await waitForPaint(noteId, pushedAt)
        log.warn(`open ${i + 1}/${total}`, { noteId, ms: painted })
        setTraces(getTraces())
        router.back()
        await delay(SETTLE_MS)
      }
      setProgress({ done: total, total })
      const measured = summarizeOpenTraces(getTraces())
      setTraces(getTraces())
      // The asset stamp is in the report because an absent guest mark reads
      // identically to a stale prebuilt bundle, and one of those is a finding
      // while the other is a rebuild the runner forgot.
      const report = `${pool}\neditor-web asset ${EDITOR_WEB_CONTRACT_HASH}\n${formatOpenTraceReport(measured)}`
      log.warn(report)
      const written = writeReport(report)
      setStatus(written ? `${pool}\nreport → ${written}` : pool)
    } catch (err) {
      setStatus(err instanceof Error ? `${err.name}: ${err.message}` : String(err))
    } finally {
      setProbeEnabled(false)
      setRunning(false)
    }
  }, [])

  // Drivable from `xcrun simctl openurl booted "memry://open-trace?autorun=1"`,
  // because the simulator offers no way to tap a button.
  const autostarted = useRef(false)
  useEffect(() => {
    if (!autorun || autostarted.current) return
    autostarted.current = true
    void run({ total: iterations, sizeEnd: size, probe })
  }, [autorun, iterations, probe, run, size])

  const summary: OpenTraceSummary | null = traces.length > 0 ? summarizeOpenTraces(traces) : null
  const timedOut = traces.length - (summary?.endToEnd.samples ?? 0)

  return (
    <SafeAreaView style={styles.safe}>
      <ThemedView style={styles.container}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <ThemedText type="title">Note-open trace</ThemedText>
          <ThemedText type="small">
            Opens {iterations} notes through the real router and reports where the time goes.
            {size ? ` Restricted to the ${size}est ${SIZE_POOL} notes by body length.` : ''}
          </ThemedText>
          <ThemedText type="small">
            docStart…guestPainted are the guest&apos;s own marks, rebased onto this clock. An empty
            row is a mark the guest never reached, not a zero.
          </ThemedText>
          <ThemedText type="small">
            sessionReady reads near zero here: this screen warmed getEditorSession before the run,
            so it is not a cold-launch number.
          </ThemedText>
          <ThemedText type="small">
            The doc manager caches open docs, so a note opened twice in one run is warm the second
            time.
          </ThemedText>

          <Pressable
            style={styles.button}
            onPress={() => void run({ total: iterations, sizeEnd: size, probe })}
            disabled={running}
            accessibilityRole="button"
            accessibilityLabel="Reset and re-run the open trace"
          >
            <ThemedText type="smallBold">{running ? 'Running…' : 'Reset and re-run'}</ThemedText>
          </Pressable>

          {running && progress ? (
            <ThemedText type="small">
              ⏳ iteration {progress.done + 1} / {progress.total}
            </ThemedText>
          ) : null}
          {status ? <ThemedText type="smallBold">{status}</ThemedText> : null}

          {summary ? (
            <>
              <ThemedText type="title">Phases</ThemedText>
              <View style={styles.row}>
                <ThemedText type="smallBold" style={styles.phaseCell}>
                  phase
                </ThemedText>
                <ThemedText type="smallBold" style={styles.numberCell}>
                  n
                </ThemedText>
                <ThemedText type="smallBold" style={styles.numberCell}>
                  p50
                </ThemedText>
                <ThemedText type="smallBold" style={styles.numberCell}>
                  p95
                </ThemedText>
                <ThemedText type="smallBold" style={styles.numberCell}>
                  max
                </ThemedText>
              </View>
              {summary.phases.map((entry) => (
                <View key={entry.phase} style={styles.row}>
                  <ThemedText type="small" style={styles.phaseCell}>
                    {entry.phase}
                  </ThemedText>
                  <ThemedText type="small" style={styles.numberCell}>
                    {entry.samples.samples}
                  </ThemedText>
                  <ThemedText type="small" style={styles.numberCell}>
                    {entry.samples.p50}
                  </ThemedText>
                  <ThemedText type="small" style={styles.numberCell}>
                    {entry.samples.p95}
                  </ThemedText>
                  <ThemedText type="small" style={styles.numberCell}>
                    {entry.samples.max}
                  </ThemedText>
                </View>
              ))}
              <View style={styles.row}>
                <ThemedText type="smallBold" style={styles.phaseCell}>
                  navigate → painted
                </ThemedText>
                <ThemedText type="smallBold" style={styles.numberCell}>
                  {summary.endToEnd.samples}
                </ThemedText>
                <ThemedText type="smallBold" style={styles.numberCell}>
                  {summary.endToEnd.p50}
                </ThemedText>
                <ThemedText type="smallBold" style={styles.numberCell}>
                  {summary.endToEnd.p95}
                </ThemedText>
                <ThemedText type="smallBold" style={styles.numberCell}>
                  {summary.endToEnd.max}
                </ThemedText>
              </View>
              <ThemedText type="small">
                {summary.traces} traces recorded, {timedOut} timed out without painting.
              </ThemedText>

              <ThemedText type="title">Intervals</ThemedText>
              {summary.intervals.map((entry) => (
                <View key={entry.label} style={styles.row}>
                  <ThemedText type="small" style={styles.phaseCell}>
                    {entry.label}
                  </ThemedText>
                  <ThemedText type="small" style={styles.numberCell}>
                    {entry.samples.samples}
                  </ThemedText>
                  <ThemedText type="small" style={styles.numberCell}>
                    {entry.samples.p50}
                  </ThemedText>
                  <ThemedText type="small" style={styles.numberCell}>
                    {entry.samples.p95}
                  </ThemedText>
                  <ThemedText type="small" style={styles.numberCell}>
                    {entry.samples.max}
                  </ThemedText>
                </View>
              ))}

              <ThemedText type="title">doc-load payload</ThemedText>
              {summary.payload.map((entry) => (
                <View key={entry.field} style={styles.row}>
                  <ThemedText type="small" style={styles.phaseCell}>
                    {entry.field}
                  </ThemedText>
                  <ThemedText type="small" style={styles.numberCell}>
                    {entry.samples.samples}
                  </ThemedText>
                  <ThemedText type="small" style={styles.numberCell}>
                    {entry.samples.p50}
                  </ThemedText>
                  <ThemedText type="small" style={styles.numberCell}>
                    {entry.samples.p95}
                  </ThemedText>
                  <ThemedText type="small" style={styles.numberCell}>
                    {entry.samples.max}
                  </ThemedText>
                </View>
              ))}
            </>
          ) : null}

          {traces.length > 0 ? (
            <>
              <ThemedText type="title">Per iteration</ThemedText>
              {/* In run order, and unaveraged: an outlier is the finding, and a
                  percentile table is exactly where it disappears. */}
              {traces.map((trace, index) => (
                <ThemedText key={`${trace.noteId}-${trace.startedAt}`} type="small">
                  {index + 1}.{' '}
                  {trace.phases.painted === undefined
                    ? 'never painted'
                    : `${trace.phases.painted} ms`}
                  {index === 0 ? '  ← cold' : ''}
                </ThemedText>
              ))}
            </>
          ) : null}
        </ScrollView>
      </ThemedView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: { flex: 1 },
  scroll: { padding: Spacing.three, gap: Spacing.two },
  button: {
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(127,127,127,0.4)',
    paddingVertical: Spacing.two
  },
  row: { flexDirection: 'row', alignItems: 'center' },
  phaseCell: { flex: 1 },
  // No `textAlign` on the numbers: React Native's only right-ish value is the
  // physical `right`, and a fixed-width column reads well enough without it.
  numberCell: { width: 52 }
})
