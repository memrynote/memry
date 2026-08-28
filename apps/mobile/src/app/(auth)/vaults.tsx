import { useCallback, useEffect, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'

import { AppText } from '@/components/ui/app-text'
import { Icon } from '@/components/ui/icon'
import { SkeletonRow } from '@/components/ui/skeleton-row'
import { AUTH_GUTTER } from '@/features/auth/chrome'
import { withThousands } from '@/lib/format'
import { extractErrorMessage, SyncRequestError } from '@/lib/errors'
import {
  listVaults,
  loadSession,
  saveCurrentVaultId,
  signOut,
  type RemoteVault
} from '@/sync/auth-client'
import { readSyncState } from '@/sync/sync-state'
import { sizes, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

const ROW_HEIGHT = 72
const ICON_LANE = 28
const CHEVRON_LANE = 24

interface VaultCard {
  vault: RemoteVault
  /** Local sync footing. `null` when this device has never opened the vault. */
  lastSuccessAt: number | null
  onThisDevice: boolean
}

function since(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/**
 * The server tracks no per-device sync clock, so the freshness half of this
 * line is read locally and only the item count comes off the wire.
 */
function subtitle(card: VaultCard, now: number): string {
  const items = `${withThousands(card.vault.itemCount)} items`
  if (!card.onThisDevice) return `${items} · not on this device yet`
  if (card.lastSuccessAt === null) return `${items} · not synced yet`
  return `${items} · last synced ${since(card.lastSuccessAt, now)}`
}

/** Vault picker (Paper `06 · Auth — Vault picker`, FR-004 multi-vault). */
export default function VaultsScreen() {
  const c = useColors()
  const [cards, setCards] = useState<VaultCard[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Anchored to the response so a row cannot age from "2 minutes" to "3" while
  // the user is still looking at it.
  const [loadedAt, setLoadedAt] = useState(() => Date.now())

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const session = await loadSession()
        if (!session) {
          router.replace('/welcome')
          return
        }
        const remote = await listVaults(session.accessToken)
        const resolved = await Promise.all(
          remote.map(async (vault): Promise<VaultCard> => {
            const state = await readSyncState(vault.vaultUuid)
            return {
              vault,
              lastSuccessAt: state?.lastSuccessAt ?? null,
              onThisDevice: state !== null
            }
          })
        )
        if (cancelled) return
        setLoadedAt(Date.now())
        setCards(resolved)
      } catch (err) {
        if (cancelled) return
        // An expired session is not something the user can act on here, so it
        // returns them to sign-in rather than printing the token error.
        if (err instanceof SyncRequestError && err.status === 401) {
          await signOut()
          router.replace('/welcome')
          return
        }
        setError(
          extractErrorMessage(err, 'Could not load your vaults. Check your connection and try again.')
        )
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const pick = useCallback(async (vault: RemoteVault) => {
    await saveCurrentVaultId(vault.vaultUuid)
    router.replace('/unlock')
  }, [])

  const leave = useCallback(async () => {
    await signOut()
    router.replace('/welcome')
  }, [])

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.canvas.background }]}>
      <View style={styles.nav}>
        <Pressable accessibilityRole="button" accessibilityLabel="Sign out" onPress={leave}>
          <AppText variant="body" color={c.tint.base}>
            Sign out
          </AppText>
        </Pressable>
      </View>

      <View style={styles.title}>
        <AppText variant="largeTitle">Your vaults</AppText>
      </View>
      <View style={styles.subtitle}>
        <AppText variant="body" color={c.text.secondary}>
          Choose which vault to open on this device. You can switch later in Settings.
        </AppText>
      </View>

      <ScrollView style={styles.flex}>
        {error ? (
          <View style={styles.notice}>
            <AppText variant="body" color={c.ui.destructiveText} accessibilityRole="alert">
              {error}
            </AppText>
          </View>
        ) : null}

        {cards === null && !error ? (
          <View style={[styles.list, { borderTopColor: c.line.border }]}>
            <SkeletonRow />
            <SkeletonRow />
          </View>
        ) : null}

        {cards !== null && cards.length === 0 ? (
          <View style={styles.notice}>
            <AppText variant="body" color={c.text.secondary}>
              No vaults on this account yet. Create one on desktop first.
            </AppText>
          </View>
        ) : null}

        {cards !== null && cards.length > 0 ? (
          <View style={[styles.list, { borderTopColor: c.line.border }]}>
            {cards.map((card) => (
              <Pressable
                key={card.vault.vaultUuid}
                accessibilityRole="button"
                accessibilityLabel={`Open vault ${card.vault.name ?? 'Vault'}`}
                onPress={() => pick(card.vault)}
                style={({ pressed }) => [
                  styles.row,
                  { borderBottomColor: c.line.border },
                  pressed && { backgroundColor: c.canvas.surfaceActive }
                ]}
              >
                <View style={styles.iconLane}>
                  <Icon name="lock" size={20} color={c.text.tertiary} />
                </View>
                <View style={styles.rowText}>
                  <AppText variant="headline">{card.vault.name ?? 'Vault'}</AppText>
                  <AppText variant="footnote" color={c.text.secondary}>
                    {subtitle(card, loadedAt)}
                  </AppText>
                </View>
                <View style={styles.chevronLane}>
                  <Icon name="chevron-right" size={20} color={c.text.tertiary} />
                </View>
              </Pressable>
            ))}
          </View>
        ) : null}
      </ScrollView>

      <View style={styles.footnote}>
        <AppText variant="caption" color={c.text.secondary} style={styles.centered}>
          Each vault is unlocked separately with its own recovery phrase.
        </AppText>
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  nav: {
    height: sizes.navBar,
    alignItems: 'center',
    justifyContent: 'flex-end',
    flexDirection: 'row',
    paddingHorizontal: sizes.gutter
  },
  title: { paddingHorizontal: sizes.gutter, paddingBottom: space.s8 },
  subtitle: { paddingHorizontal: sizes.gutter, paddingBottom: space.s20 },
  list: { borderTopWidth: 1 },
  row: {
    height: ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s12,
    paddingHorizontal: sizes.gutter,
    borderBottomWidth: 1
  },
  // Fixed lanes, so the titles and chevrons line up across rows whatever the
  // subtitle says.
  iconLane: { width: ICON_LANE, flexShrink: 0 },
  chevronLane: { width: CHEVRON_LANE, flexShrink: 0, alignItems: 'flex-end' },
  rowText: { flex: 1, gap: space.s2 },
  notice: { paddingHorizontal: sizes.gutter, paddingVertical: space.s12 },
  footnote: { paddingHorizontal: AUTH_GUTTER, paddingBottom: space.s8 },
  centered: { textAlign: 'center' }
})
