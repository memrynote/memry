import { useEffect, useState } from 'react'
import { ActivityIndicator } from 'react-native'
import { Redirect } from 'expo-router'
import { ThemedView } from '@/components/themed-view'
import { isVaultUnlocked } from '@/lib/vault-unlock'
import { loadCurrentVaultId, loadSession } from '@/sync/auth-client'

type Destination = '/sign-in' | '/vaults' | '/unlock' | '/notes'

/** Entry gate: session → vault → unlock state decides where the app opens. */
export default function Entry() {
  const [destination, setDestination] = useState<Destination | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const session = await loadSession()
      if (!session) {
        if (!cancelled) setDestination('/sign-in')
        return
      }
      const vaultId = await loadCurrentVaultId()
      if (!vaultId) {
        if (!cancelled) setDestination('/vaults')
        return
      }
      const unlocked = await isVaultUnlocked(vaultId)
      if (!cancelled) setDestination(unlocked ? '/notes' : '/unlock')
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (!destination) {
    return (
      <ThemedView style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </ThemedView>
    )
  }
  return <Redirect href={destination} />
}
