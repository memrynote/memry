import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { ThemedText } from '@/components/themed-text'
import { ThemedView } from '@/components/themed-view'
import { Spacing } from '@/constants/theme'
import { extractErrorMessage } from '@/lib/errors'
import { listVaults, loadSession, saveCurrentVaultId, type RemoteVault } from '@/sync/auth-client'

/** Vault picker (T043, FR-004 multi-vault). */
export default function VaultsScreen() {
  const [vaults, setVaults] = useState<RemoteVault[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const session = await loadSession()
        if (!session) {
          router.replace('/sign-in')
          return
        }
        const remote = await listVaults(session.accessToken)
        if (!cancelled) setVaults(remote)
      } catch (err) {
        if (!cancelled) setError(extractErrorMessage(err, 'Could not load your vaults.'))
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

  return (
    <SafeAreaView style={styles.safe}>
      <ThemedView style={styles.container}>
        <ThemedText type="title">Choose a vault</ThemedText>
        {error ? (
          <ThemedText type="small" style={styles.error} accessibilityRole="alert">
            {error}
          </ThemedText>
        ) : null}
        {vaults === null && !error ? <ActivityIndicator /> : null}
        {vaults !== null && vaults.length === 0 ? (
          <ThemedText type="small">
            No vaults on this account yet. Create one on desktop first.
          </ThemedText>
        ) : null}
        <FlatList
          data={vaults ?? []}
          keyExtractor={(v) => v.vaultUuid}
          renderItem={({ item }) => (
            <Pressable
              style={styles.row}
              onPress={() => pick(item)}
              accessibilityRole="button"
              accessibilityLabel={`Open vault ${item.name ?? item.vaultUuid}`}
            >
              <ThemedText type="smallBold">{item.name ?? 'Vault'}</ThemedText>
              <ThemedText type="small">{item.itemCount} items</ThemedText>
            </Pressable>
          )}
        />
      </ThemedView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: { flex: 1, padding: Spacing.four, gap: Spacing.three },
  row: {
    borderWidth: 1,
    borderColor: 'rgba(127,127,127,0.3)',
    borderRadius: 8,
    padding: Spacing.three,
    marginBottom: Spacing.two,
    gap: 2
  },
  error: { color: '#c0392b' }
})
