import { useCallback, useState } from 'react'
import { Pressable, ScrollView, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ThemedText } from '@/components/themed-text'
import { ThemedView } from '@/components/themed-view'
import { Spacing } from '@/constants/theme'
import {
  runMobileConformance,
  runPullPipelineRoundTrip,
  type HarnessResult
} from '@/sync/__harness__/us1-seam-harness'

/** Dev runner for the T054 on-device seam tests (real adapters, no mocks). */
export default function SeamTestsScreen() {
  const [conformance, setConformance] = useState<HarnessResult | null>(null)
  const [roundTrip, setRoundTrip] = useState<HarnessResult | null>(null)
  const [busy, setBusy] = useState(false)

  const runAll = useCallback(() => {
    setBusy(true)
    setTimeout(async () => {
      try {
        const c = await runMobileConformance()
        setConformance(c)
        const r = await runPullPipelineRoundTrip()
        setRoundTrip(r)
      } finally {
        setBusy(false)
      }
    }, 50)
  }, [])

  const render = (label: string, r: HarnessResult | null) =>
    r === null ? null : (
      <>
        <ThemedText type="smallBold">
          {label}: {r.failed === 0 ? 'PASS' : 'FAIL'} ({r.passed} passed, {r.failed} failed)
        </ThemedText>
        {r.failures.map((f) => (
          <ThemedText key={f} type="small">
            ✗ {f}
          </ThemedText>
        ))}
      </>
    )

  return (
    <SafeAreaView style={styles.safe}>
      <ThemedView style={styles.container}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <ThemedText type="title">US1 seam tests</ThemedText>
          <Pressable
            style={styles.button}
            onPress={runAll}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Run seam tests"
          >
            <ThemedText type="smallBold">
              {busy ? 'Running…' : 'Run conformance + pull round-trip'}
            </ThemedText>
          </Pressable>
          {render('Conformance', conformance)}
          {render('Pull round-trip', roundTrip)}
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
  }
})
