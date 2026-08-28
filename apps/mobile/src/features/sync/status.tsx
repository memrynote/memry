import { useEffect, useState, type ReactNode } from 'react'
import { Linking, Pressable, StyleSheet, View } from 'react-native'
import NetInfo from '@react-native-community/netinfo'

import { AppText } from '@/components/ui/app-text'
import { Icon, type IconName } from '@/components/ui/icon'
import { isDevOffline, subscribeDevOffline } from '@/lib/dev-network'
import { extractErrorMessage } from '@/lib/errors'
import { createLogger } from '@/lib/logger'
import { subscribeReadOnly, type ReadOnlyState } from '@/sync/read-only-mode'
import { fontFamilies } from '@/theme/fonts'
import { sizes } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

const log = createLogger('SyncStatusBanner')

// Boards 21 and 22 draw the band at 10pt block padding, a 10pt gap and an 18pt
// glyph. None of the three is on the space scale, so they stay local rather
// than growing the scale for one component (the nav bar's action gap makes the
// same call).
const BAND_PADDING_Y = 10
const BAND_GAP = 10
const GLYPH = 18

/**
 * Where `Update` sends someone on a version gate.
 *
 * The bare App Store scheme, not a listing URL: Memry has no numeric App Store
 * id yet, and `id0000000000` would open a dead page on a real device while
 * looking correct in review.
 */
const APP_STORE_URL = 'itms-apps://'

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
 * The band claims no safe-area inset of its own. `(vault)/_layout.tsx` owns the
 * top inset for the whole shell, which is what stops the message rendering
 * under the clock and what keeps every screen's geometry identical whether or
 * not a banner is showing.
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
    // Board 22 draws one read-only sentence; these are two, because only the
    // version gate is something the person holding the phone can act on. The
    // server-side pause clears itself, so flattening them would offer an
    // `Update` that fixes nothing.
    const message =
      readOnly.reason === 'version-gate'
        ? `Read-only. This version can read your vault, but the server needs ${readOnly.minWriteVersion ?? 'a newer version'} to write.`
        : 'Read-only. The server paused writes; your changes wait here and send themselves when writing is back.'
    return (
      <Band
        testID="sync-banner-read-only"
        role="alert"
        icon="warning"
        tone="sand"
        message={message}
        action={readOnly.reason === 'version-gate' ? <UpdateAction /> : null}
      />
    )
  }

  if (locked) {
    return <Band testID="sync-banner-locked" icon="lock" message="Vault locked" />
  }

  if (!online) {
    return (
      <Band
        testID="sync-banner-offline"
        icon="offline"
        message="Offline. Your edits are saved here and will sync when you reconnect."
      />
    )
  }

  if (unsyncedCount > 0) {
    return (
      <Band
        testID="sync-banner-unsynced"
        icon="sync"
        message={`Sending ${unsyncedCount} change${unsyncedCount === 1 ? '' : 's'}…`}
      />
    )
  }

  if (syncing) {
    return <Band testID="sync-banner-syncing" icon="sync" message="Syncing…" />
  }

  return null
}

/**
 * The band every variant draws (boards 21 and 22).
 *
 * `accessible` sits on the glyph + message group rather than on the row, and
 * that is load-bearing rather than tidy. A plain `View` wrapping `Text` is NOT
 * an accessibility element on iOS: the children are, so a container label never
 * reaches the tree and neither VoiceOver nor Maestro can address the banner as
 * one thing. The first offline-matrix run dumped a hierarchy holding
 * `Sending 12 changes…` and no `Unsynced changes` node at all — which is why
 * `id:` selectors matched nothing. `accessible` merges the children into one
 * element and `testID` gives it a stable identifier that survives copy edits.
 *
 * It stops at the message group because marking the whole row would swallow
 * `Update` into that one element and leave the only actionable control in the
 * banner unreachable to VoiceOver.
 */
function Band({
  testID,
  role = 'text',
  icon,
  tone = 'surface',
  message,
  action = null
}: {
  testID: string
  role?: 'text' | 'alert'
  icon: IconName
  tone?: 'surface' | 'sand'
  message: string
  action?: ReactNode
}) {
  const c = useColors()
  const sand = tone === 'sand'
  const color = sand ? c.text.primary : c.text.secondary

  return (
    <View style={[styles.band, { backgroundColor: sand ? c.pastel.sand : c.canvas.surface }]}>
      <View
        style={styles.group}
        accessible
        testID={testID}
        accessibilityRole={role}
        accessibilityLabel={message}
      >
        <Icon name={icon} size={GLYPH} color={color} />
        <AppText variant="footnote" color={color} style={styles.message}>
          {message}
        </AppText>
      </View>
      {action}
    </View>
  )
}

function UpdateAction() {
  const c = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Update"
      hitSlop={10}
      onPress={() => {
        void Linking.openURL(APP_STORE_URL).catch((err: unknown) => {
          log.warn('Opening the App Store failed', {
            error: extractErrorMessage(err, 'unknown error')
          })
        })
      }}
    >
      <AppText variant="footnote" color={c.text.primary} style={styles.action}>
        Update
      </AppText>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  band: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: BAND_PADDING_Y,
    paddingHorizontal: sizes.gutter,
    gap: BAND_GAP
  },
  group: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: BAND_GAP },
  message: { flex: 1 },
  action: { flexShrink: 0, fontFamily: fontFamilies.sansSemiBold }
})
