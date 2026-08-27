import { useCallback, useState } from 'react'
import { Alert, Pressable, ScrollView, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ThemedText } from '@/components/themed-text'
import { ThemedView } from '@/components/themed-view'
import { Spacing } from '@/constants/theme'
import { wipeDeviceState } from '@/lib/dev-wipe'
import { isDevOffline, setDevOffline } from '@/lib/dev-network'
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
  const [step, setStep] = useState<string | null>(null)
  const [crash, setCrash] = useState<string | null>(null)
  const [wipeState, setWipeState] = useState<string | null>(null)
  const [devOffline, setDevOfflineState] = useState(isDevOffline())

  const confirmWipe = useCallback(() => {
    Alert.alert(
      'Wipe device state?',
      'Clears the session, vault keys, device id and all local vault data. ' +
        'Kill and relaunch the app right after — the next launch is a first launch.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Wipe',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await wipeDeviceState()
                setWipeState('Wiped — now kill and relaunch the app.')
              } catch (err) {
                setWipeState(`Wipe failed: ${err instanceof Error ? err.message : String(err)}`)
              }
            })()
          }
        }
      ]
    )
  }, [])

  const runAll = useCallback(() => {
    setBusy(true)
    setTimeout(async () => {
      try {
        setCrash(null)
        setStep('conformance')
        const c = await runMobileConformance()
        setConformance(c)
        const r = await runPullPipelineRoundTrip((s) => setStep(s))
        setRoundTrip(r)
        setStep(null)
      } catch (err) {
        setCrash(err instanceof Error ? `${err.name}: ${err.message.slice(0, 500)}` : String(err))
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
        {(r.notes ?? []).map((n) => (
          <ThemedText key={n} type="small">
            ℹ {n}
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
          {step ? <ThemedText type="small">⏳ {step}</ThemedText> : null}
          {crash ? <ThemedText type="smallBold">💥 round-trip threw: {crash}</ThemedText> : null}
          {render('Conformance', conformance)}
          {render('Pull round-trip', roundTrip)}
          <ThemedText type="title">Network</ThemedText>
          {/*
            The same switch the offline matrix drives by deep link, surfaced so
            the offline paths can be exercised by hand. Dev builds only —
            `setDevOffline` is a no-op in a release build.
          */}
          <Pressable
            style={styles.button}
            onPress={() => {
              setDevOffline(!devOffline)
              setDevOfflineState(!devOffline)
            }}
            accessibilityRole="button"
            accessibilityLabel="Toggle dev offline"
          >
            <ThemedText type="smallBold">
              {devOffline
                ? 'Dev network: OFFLINE (tap to restore)'
                : 'Dev network: online (tap to cut)'}
            </ThemedText>
          </Pressable>

          <ThemedText type="title">Danger zone</ThemedText>
          <Pressable
            style={styles.button}
            onPress={confirmWipe}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Wipe device state"
          >
            <ThemedText type="smallBold">Wipe device state (sign-out + delete vaults)</ThemedText>
          </Pressable>
          {wipeState ? <ThemedText type="small">{wipeState}</ThemedText> : null}
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
