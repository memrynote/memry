import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router, useLocalSearchParams } from 'expo-router'
import { ThemedText } from '@/components/themed-text'
import { ThemedView } from '@/components/themed-view'
import { Spacing } from '@/constants/theme'
import {
  getTraces,
  OPEN_PHASES,
  resetTraces,
  summarizeOpenTraces,
  type OpenTraceSummary
} from '@/editor/__rig__/open-trace'
import { getEditorSession } from '@/editor/session'
import { readNotesSnapshot } from '@/features/notes/notes-repo'
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

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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

export default function OpenTraceScreen() {
  const params = useLocalSearchParams<{ autorun?: string; n?: string }>()
  const requested = Number.parseInt(params.n ?? '', 10)
  const iterations = Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_ITERATIONS
  const autorun = params.autorun === '1'

  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [samples, setSamples] = useState<(number | null)[]>([])
  const [summary, setSummary] = useState<OpenTraceSummary | null>(null)

  const run = useCallback(async (total: number) => {
    setRunning(true)
    setStatus(null)
    setSummary(null)
    setSamples([])
    try {
      const vaultId = await loadCurrentVaultId()
      if (!vaultId) {
        setStatus('Not signed into a vault — there is nothing to open.')
        return
      }
      const session = await getEditorSession(vaultId)
      const snapshot = await readNotesSnapshot(session.db)
      // Notes with a body first: an empty note skips the seed probe and most of
      // the guest's parse work, so timing those would flatter the baseline.
      const withBody = snapshot.entries.filter((entry) => entry.hasBody)
      const ids = (withBody.length > 0 ? withBody : snapshot.entries).map((entry) => entry.id)
      if (ids.length === 0) {
        setStatus('This vault has no notes.')
        return
      }

      resetTraces()
      const results: (number | null)[] = []
      for (let i = 0; i < total; i++) {
        setProgress({ done: i, total })
        // Consecutive iterations open DIFFERENT notes, so the doc manager's
        // cache is not what is being measured on every run but the first.
        const noteId = ids[i % ids.length]
        const pushedAt = Date.now()
        router.push(`/notes/${noteId}`)
        results.push(await waitForPaint(noteId, pushedAt))
        setSamples([...results])
        router.back()
        await delay(SETTLE_MS)
      }
      setProgress({ done: total, total })
      setSummary(summarizeOpenTraces(getTraces()))
    } catch (err) {
      setStatus(err instanceof Error ? `${err.name}: ${err.message}` : String(err))
    } finally {
      setRunning(false)
    }
  }, [])

  // Drivable from `xcrun simctl openurl booted "memry://open-trace?autorun=1"`,
  // because the simulator offers no way to tap a button.
  const autostarted = useRef(false)
  useEffect(() => {
    if (!autorun || autostarted.current) return
    autostarted.current = true
    void run(iterations)
  }, [autorun, iterations, run])

  const timedOut = samples.filter((value) => value === null).length

  return (
    <SafeAreaView style={styles.safe}>
      <ThemedView style={styles.container}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <ThemedText type="title">Note-open trace</ThemedText>
          <ThemedText type="small">
            Opens {iterations} notes through the real router and reports where the time goes.
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
            onPress={() => void run(iterations)}
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
            </>
          ) : null}

          {samples.length > 0 ? (
            <>
              <ThemedText type="title">Per iteration</ThemedText>
              {/* In run order, and unaveraged: an outlier is the finding, and a
                  percentile table is exactly where it disappears. */}
              {samples.map((value, index) => (
                <ThemedText key={index} type="small">
                  {index + 1}. {value === null ? 'timed out' : `${value} ms`}
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
