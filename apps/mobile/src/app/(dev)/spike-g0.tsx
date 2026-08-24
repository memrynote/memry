import { createId } from '@memry/app-core/ids'
import { ARGON2_PARAMS } from '@memry/contracts/crypto'
import * as Device from 'expo-device'
import { useCallback, useEffect, useState } from 'react'
import { Platform, Pressable, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { runVectorParity } from '@/crypto/__harness__/vector-parity'

import { AnimatedIcon } from '@/components/animated-icon'
import { HintRow } from '@/components/hint-row'
import { ThemedText } from '@/components/themed-text'
import { ThemedView } from '@/components/themed-view'
import { WebBadge } from '@/components/web-badge'
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme'

function getDevMenuHint() {
  if (Platform.OS === 'web') {
    return <ThemedText type="small">use browser devtools</ThemedText>
  }
  if (Device.isDevice) {
    return (
      <ThemedText type="small">
        shake device or press <ThemedText type="code">m</ThemedText> in terminal
      </ThemedText>
    )
  }
  const shortcut = Platform.OS === 'android' ? 'cmd+m (or ctrl+m)' : 'cmd+d'
  return (
    <ThemedText type="small">
      press <ThemedText type="code">{shortcut}</ThemedText>
    </ThemedText>
  )
}

// T008 (G0-a): runs every committed crypto vector through the JSI binding.
// Expected: "PARITY OK n/n vectors". Gate evidence requires the physical
// reference device + release build (Argon2id 64 MiB memory pressure).
function ParityRow() {
  const [status, setStatus] = useState('tap to run')

  const run = useCallback(() => {
    setStatus('running… (Argon2id 64 MiB ×3)')
    // Let the status render before the synchronous pwhash calls block JS.
    setTimeout(async () => {
      try {
        const report = await runVectorParity()
        console.log(`[crypto-parity] ${report.summary}`)
        setStatus(report.summary)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.log(`[crypto-parity] HARNESS ERROR: ${message}`)
        setStatus(`HARNESS ERROR: ${message}`)
      }
    }, 50)
  }, [])

  // Dev builds run the parity check once on mount so the result also lands in
  // the Metro log — the tap stays for re-runs and for release-build evidence.
  useEffect(() => {
    if (!__DEV__) {
      return
    }
    const timer = setTimeout(run, 0)
    return () => clearTimeout(timer)
  }, [run])

  return (
    <HintRow
      title="Crypto parity"
      hint={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Run crypto parity vectors"
          onPress={run}
        >
          <ThemedText type="code">{status}</ThemedText>
        </Pressable>
      }
    />
  )
}

export default function HomeScreen() {
  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ThemedView style={styles.heroSection}>
          <AnimatedIcon />
          <ThemedText type="title" style={styles.title}>
            Welcome to&nbsp;Expo
          </ThemedText>
        </ThemedView>

        <ThemedText type="code" style={styles.code}>
          get started
        </ThemedText>

        <ThemedView type="backgroundElement" style={styles.stepContainer}>
          <HintRow
            title="Try editing"
            hint={<ThemedText type="code">src/app/index.tsx</ThemedText>}
          />
          <HintRow title="Dev tools" hint={getDevMenuHint()} />
          <HintRow
            title="Fresh start"
            hint={<ThemedText type="code">npm run reset-project</ThemedText>}
          />
          {/* R3 spike proof (T010): Metro bundles workspace raw-TS exports —
              @memry/contracts + a pure @memry/app-core slice. */}
          <HintRow
            title="Workspace TS"
            hint={
              <ThemedText type="code">
                {createId('spike').slice(0, 12)} · argon2 {ARGON2_PARAMS.OPS_LIMIT}x
                {ARGON2_PARAMS.MEMORY_LIMIT / 1024 / 1024} MiB
              </ThemedText>
            }
          />
          <ParityRow />
        </ThemedView>

        {Platform.OS === 'web' && <WebBadge />}
      </SafeAreaView>
    </ThemedView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    flexDirection: 'row'
  },
  safeArea: {
    flex: 1,
    paddingHorizontal: Spacing.four,
    alignItems: 'center',
    gap: Spacing.three,
    paddingBottom: BottomTabInset + Spacing.three,
    maxWidth: MaxContentWidth
  },
  heroSection: {
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    paddingHorizontal: Spacing.four,
    gap: Spacing.four
  },
  title: {
    textAlign: 'center'
  },
  code: {
    textTransform: 'uppercase'
  },
  stepContainer: {
    gap: Spacing.three,
    alignSelf: 'stretch',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.four,
    borderRadius: Spacing.four
  }
})
