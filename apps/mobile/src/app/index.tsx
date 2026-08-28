import { useEffect, useState } from 'react'
import { Redirect } from 'expo-router'

import { BrandSplash } from '@/features/auth/brand-splash'
import { isVaultUnlocked } from '@/lib/vault-unlock'
import { loadCurrentVaultId, loadSession } from '@/sync/auth-client'

type Destination = '/welcome' | '/vaults' | '/unlock' | '/notes'

/** Entry gate: session → vault → unlock state decides where the app opens. */
export default function Entry() {
  const [destination, setDestination] = useState<Destination | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const session = await loadSession()
      if (!session) {
        if (!cancelled) setDestination('/welcome')
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

  // The gate reads the keychain, so it is never instant. Showing the brand
  // field rather than a spinner keeps the launch one continuous surface.
  if (!destination) return <BrandSplash status="Unlocking your vault…" />
  return <Redirect href={destination} />
}
