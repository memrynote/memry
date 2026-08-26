import { useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import NetInfo from '@react-native-community/netinfo'
import { ThemedText } from '@/components/themed-text'
import { Spacing } from '@/constants/theme'
import { subscribeReadOnly, type ReadOnlyState } from '@/sync/read-only-mode'

/**
 * Sync/degraded-state banner (T053) using desktop's vocabulary: offline,
 * syncing, locked, read-only. Renders nothing when everything is healthy.
 * Read-only carries the plain explanation + update path (FR-010).
 *
 * `unsyncedCount` is the outbox depth (US2). It is deliberately its own state
 * rather than folded into "syncing": "we are pulling" and "your edits have not
 * left this device yet" answer different questions, and the offline matrix
 * asserts on the second one specifically — a run that only waited for the pull
 * indicator would call a full outbox a success.
 */
export function SyncStatusBanner({
  syncing,
  locked,
  unsyncedCount = 0
}: {
  syncing?: boolean
  locked?: boolean
  unsyncedCount?: number
}) {
  const [online, setOnline] = useState(true)
  const [readOnly, setReadOnly] = useState<ReadOnlyState>({ readOnly: false, reason: null })

  useEffect(() => {
    const unsubNet = NetInfo.addEventListener((state) => {
      setOnline(state.isConnected === true && state.isInternetReachable !== false)
    })
    const unsubPolicy = subscribeReadOnly(setReadOnly)
    return () => {
      unsubNet()
      unsubPolicy()
    }
  }, [])

  if (readOnly.readOnly) {
    const explanation =
      readOnly.reason === 'version-gate'
        ? `This version of Memry can read your vault but the server requires ${readOnly.minWriteVersion ?? 'a newer version'} for changes. Update the app from the App Store to write again.`
        : 'Memry is temporarily read-only while we protect your data on the server side. Your notes are safe and readable; changes wait and send themselves once writing is back.'
    return (
      <View
        style={[styles.banner, styles.readOnly]}
        accessibilityRole="alert"
        accessibilityLabel="Read-only mode"
      >
        <ThemedText type="smallBold">Read-only</ThemedText>
        <ThemedText type="small">{explanation}</ThemedText>
      </View>
    )
  }

  if (locked) {
    return (
      <View style={styles.banner} accessibilityRole="text" accessibilityLabel="Vault locked">
        <ThemedText type="smallBold">Locked</ThemedText>
      </View>
    )
  }

  if (!online) {
    return (
      <View style={styles.banner} accessibilityRole="text" accessibilityLabel="Offline">
        <ThemedText type="smallBold">Offline</ThemedText>
        <ThemedText type="small">
          {unsyncedCount > 0
            ? `Showing what is already on this device. ${unsyncedCount} change${unsyncedCount === 1 ? '' : 's'} will send when you reconnect.`
            : 'Showing what is already on this device.'}
        </ThemedText>
      </View>
    )
  }

  if (unsyncedCount > 0) {
    return (
      <View style={styles.banner} accessibilityRole="text" accessibilityLabel="Unsynced changes">
        <ThemedText type="small">
          Sending {unsyncedCount} change{unsyncedCount === 1 ? '' : 's'}…
        </ThemedText>
      </View>
    )
  }

  if (syncing) {
    return (
      <View style={styles.banner} accessibilityRole="text" accessibilityLabel="Syncing">
        <ThemedText type="small">Syncing…</ThemedText>
      </View>
    )
  }

  return null
}

const styles = StyleSheet.create({
  banner: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    gap: 2
  },
  readOnly: {
    borderStartWidth: 3,
    borderStartColor: '#ff671a'
  }
})
