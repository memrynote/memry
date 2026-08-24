/**
 * G0 rig screen (Train Phase 0). Hosts the three on-device gate checks:
 *   - T008 crypto vector parity (G0-a)
 *   - T009 SQLite threshold validation on expo-sqlite (G0-c)
 *   - T011 WebView bridge throughput (G0-d)
 * Throwaway-tolerant spike UI — replaced by real app surfaces from Phase 2 on.
 */
import { useCallback, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { ThemedText } from '@/components/themed-text'
import { ThemedView } from '@/components/themed-view'
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme'
import { runVectorParity } from '@/crypto/__harness__/vector-parity'
import { formatReport, runDriverBench } from '@/db/__bench__/driver-bench'
import { expoSqliteDriver } from '@/db/__bench__/drivers'
import { BridgeThroughputRig } from '@/editor/__rig__/bridge-throughput'
import {
  DEMO_SERVERS,
  pullAndDecryptNote,
  requestOtp,
  setDemoServer,
  unlockVault,
  verifyOtpAndRegister,
  type DemoServer,
  type DemoSession
} from '@/spike/g0-demo'

function RigButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={styles.button}
    >
      <ThemedText type="smallBold">{label}</ThemedText>
    </Pressable>
  )
}

// T014 (G0-e): staging sign-in → pull one desktop note → decrypt → SHA-256.
// Compare against desktop: `shasum -a 256` over the same note's raw markdown.
function GateDemoCard() {
  const session = useRef<DemoSession>({})
  const [server, setServer] = useState<DemoServer>('production')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [status, setStatus] = useState('idle')

  const switchServer = useCallback((next: DemoServer) => {
    setDemoServer(next)
    setServer(next)
    // Tokens/keys are per-server — force a clean sign-in after a switch.
    session.current = {}
    setStatus(`server: ${next} — session reset`)
  }, [])

  const step = useCallback((label: string, fn: () => Promise<string>) => {
    setStatus(`${label}…`)
    setTimeout(async () => {
      try {
        setStatus(await fn())
      } catch (error) {
        setStatus(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
      }
    }, 50)
  }, [])

  return (
    <ThemedView type="backgroundElement" style={styles.card}>
      <ThemedText type="smallBold">T014 · G0 gate demo</ThemedText>
      <RigButton
        label={`server: ${server} — tap for ${server === 'staging' ? 'production' : 'staging'}`}
        onPress={() => switchServer(server === 'staging' ? 'production' : 'staging')}
      />
      <ThemedText type="small">{DEMO_SERVERS[server]}</ThemedText>
      {server === 'production' ? (
        <ThemedText type="small">
          ⚠️ production: own account only; the only account write is the revocable device row — the
          spike never pushes items
        </ThemedText>
      ) : null}
      <TextInput
        accessibilityLabel="Staging account email"
        style={styles.input}
        placeholder="email"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <RigButton
        label="1 · Send OTP"
        onPress={() =>
          step('requesting OTP', async () => {
            await requestOtp(email.trim())
            return 'OTP sent — check the inbox'
          })
        }
      />
      <TextInput
        accessibilityLabel="One-time code"
        style={styles.input}
        placeholder="OTP code"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="number-pad"
        value={code}
        onChangeText={setCode}
      />
      <RigButton
        label="2 · Verify + register device"
        onPress={() =>
          step('verifying + registering', async () => {
            await verifyOtpAndRegister(email.trim(), code.trim(), session.current)
            return `device registered: ${session.current.deviceId}`
          })
        }
      />
      <TextInput
        accessibilityLabel="24-word recovery phrase"
        style={[styles.input, styles.phraseInput]}
        placeholder="24-word recovery phrase"
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        value={password}
        onChangeText={setPassword}
      />
      <RigButton
        label="3 · Unlock vault (phrase → Argon2id 64 MiB)"
        onPress={() =>
          step('deriving master key', async () => {
            await unlockVault(password, session.current)
            return 'vault key derived — verifier matched'
          })
        }
      />
      <RigButton
        label="4 · Pull + decrypt one note"
        onPress={() =>
          step('pulling note', async () => {
            const note = await pullAndDecryptNote(session.current)
            console.log(`[g0-demo] ${note.itemId} sha256=${note.markdownSha256}`)
            return [
              `note: ${note.title} (${note.markdownLength} chars)`,
              `item: ${note.itemId}`,
              `sha256: ${note.markdownSha256}`,
              'compare on desktop: shasum -a 256 <note.md>'
            ].join('\n')
          })
        }
      />
      <ThemedText type="code">{status}</ThemedText>
    </ThemedView>
  )
}

export default function RigScreen() {
  const insets = useSafeAreaInsets()
  const [parityStatus, setParityStatus] = useState('idle')
  const [benchStatus, setBenchStatus] = useState('idle')
  const [showBridgeRig, setShowBridgeRig] = useState(false)

  const runParity = useCallback(() => {
    setParityStatus('running… (Argon2id 64 MiB ×3)')
    setTimeout(async () => {
      try {
        const report = await runVectorParity()
        console.log(`[crypto-parity] ${report.summary}`)
        setParityStatus(report.summary)
      } catch (error) {
        setParityStatus(`HARNESS ERROR: ${error instanceof Error ? error.message : String(error)}`)
      }
    }, 50)
  }, [])

  const runBench = useCallback(() => {
    setBenchStatus('running… (10k inserts + FTS5 + 5k blobs, takes a while)')
    setTimeout(async () => {
      try {
        const report = await runDriverBench(expoSqliteDriver)
        const table = formatReport(report)
        console.log(`[sqlite-bench]\n${table}`)
        setBenchStatus(table)
      } catch (error) {
        setBenchStatus(`BENCH ERROR: ${error instanceof Error ? error.message : String(error)}`)
      }
    }, 50)
  }, [])

  return (
    <ThemedView style={styles.container}>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + Spacing.four,
            paddingBottom: insets.bottom + BottomTabInset + Spacing.three
          }
        ]}
      >
        <ThemedText type="title">G0 rigs</ThemedText>
        <ThemedText type="small">
          Gate evidence needs the physical reference device + release build. Results also land in
          the Metro log.
        </ThemedText>

        <ThemedView type="backgroundElement" style={styles.card}>
          <ThemedText type="smallBold">T008 · Crypto parity (G0-a)</ThemedText>
          <RigButton label="Run 33 vectors" onPress={runParity} />
          <ThemedText type="code">{parityStatus}</ThemedText>
        </ThemedView>

        <ThemedView type="backgroundElement" style={styles.card}>
          <ThemedText type="smallBold">T009 · expo-sqlite thresholds (G0-c)</ThemedText>
          <RigButton label="Run benchmark" onPress={runBench} />
          <ThemedText type="code">{benchStatus}</ThemedText>
        </ThemedView>

        <ThemedView type="backgroundElement" style={styles.card}>
          <ThemedText type="smallBold">T011 · Bridge throughput (G0-d)</ThemedText>
          <RigButton
            label={showBridgeRig ? 'Hide bridge rig' : 'Show bridge rig'}
            onPress={() => setShowBridgeRig((v) => !v)}
          />
          {showBridgeRig ? (
            <View style={styles.bridgeRig}>
              <BridgeThroughputRig />
            </View>
          ) : null}
        </ThemedView>

        <GateDemoCard />
      </ScrollView>
    </ThemedView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1
  },
  content: {
    gap: Spacing.four,
    paddingHorizontal: Spacing.four,
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    width: '100%'
  },
  card: {
    gap: Spacing.three,
    padding: Spacing.four,
    borderRadius: Spacing.four
  },
  button: {
    paddingVertical: Spacing.two
  },
  bridgeRig: {
    height: 560
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#8884',
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 15
  },
  phraseInput: {
    minHeight: 72
  }
})
