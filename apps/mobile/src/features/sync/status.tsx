import { useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import NetInfo from '@react-native-community/netinfo'
import { ThemedText } from '@/components/themed-text'
import { Spacing } from '@/constants/theme'
import { isDevOffline, subscribeDevOffline } from '@/lib/dev-network'
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
 *
 * Every variant is `accessible` with a `testID`, and that is load-bearing
 * rather than tidy. A plain `View` wrapping `Text` children is NOT an
 * accessibility element on iOS: the children are, so the container's
 * `accessibilityLabel` never reaches the tree and neither VoiceOver nor
 * Maestro can address the banner as one thing. The first offline-matrix run
 * dumped a hierarchy holding `Sending 12 changes…` and no `Unsynced changes`
 * node at all — which is why `id:` selectors against these labels matched
 * nothing. `accessible` merges the children into one element and `testID`
 * gives it a stable identifier that survives copy edits to the strings.
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
  const [online, setOnline] = useState(() => !isDevOffline())
  const [readOnly, setReadOnly] = useState<ReadOnlyState>({ readOnly: false, reason: null })

  useEffect(() => {
    /*
     * NetInfo alone is not the answer to "are we online".
     *
     * The dev network switch (T066) makes the HTTP adapter reject every
     * request, but it cannot reach the radio — NetInfo keeps reporting a
     * healthy connection. A banner reading NetInfo directly therefore says
     * "Sending 12 changes…" while nothing can possibly send, and the offline
     * matrix, which asserts this banner precisely so a pass cannot have run
     * online, fails on the one screen that was supposed to prove it.
     *
     * So this mirrors the adapter's own rule: real reachability AND the
     * switch. Outside `__DEV__` `isDevOffline()` is a constant false, which
     * leaves this expression exactly equal to the NetInfo-only one.
     */
    let real = true
    const apply = (): void => setOnline(real && !isDevOffline())

    const unsubNet = NetInfo.addEventListener((state) => {
      real = state.isConnected === true && state.isInternetReachable !== false
      apply()
    })
    const unsubDev = subscribeDevOffline(apply)
    // `isDevOffline()` is a pull, not a push: it notices the marker file only
    // when something asks. The engine asks on every request, so going OFFLINE
    // is seen immediately — but once the outbox is parked in backoff nothing
    // asks for a while, and the banner would sit on "Offline" long after the
    // network came back. The matrix's reconnect half waits 30 s for exactly
    // this element, so in dev the banner does its own asking.
    const poll = __DEV__ ? setInterval(apply, 500) : null
    const unsubPolicy = subscribeReadOnly(setReadOnly)
    return () => {
      unsubNet()
      unsubDev()
      if (poll) clearInterval(poll)
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
        accessible
        testID="sync-banner-read-only"
        accessibilityRole="alert"
        accessibilityLabel={`Read-only mode. ${explanation}`}
      >
        <ThemedText type="smallBold">Read-only</ThemedText>
        <ThemedText type="small">{explanation}</ThemedText>
      </View>
    )
  }

  if (locked) {
    return (
      <View
        style={styles.banner}
        accessible
        testID="sync-banner-locked"
        accessibilityRole="text"
        accessibilityLabel="Vault locked"
      >
        <ThemedText type="smallBold">Locked</ThemedText>
      </View>
    )
  }

  if (!online) {
    return (
      <View
        style={styles.banner}
        accessible
        testID="sync-banner-offline"
        accessibilityRole="text"
        accessibilityLabel="Offline. Showing what is already on this device."
      >
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
      <View
        style={styles.banner}
        accessible
        testID="sync-banner-unsynced"
        accessibilityRole="text"
        accessibilityLabel={`Unsynced changes. Sending ${unsyncedCount} change${unsyncedCount === 1 ? '' : 's'}.`}
      >
        <ThemedText type="small">
          Sending {unsyncedCount} change{unsyncedCount === 1 ? '' : 's'}…
        </ThemedText>
      </View>
    )
  }

  if (syncing) {
    return (
      <View
        style={styles.banner}
        accessible
        testID="sync-banner-syncing"
        accessibilityRole="text"
        accessibilityLabel="Syncing"
      >
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
