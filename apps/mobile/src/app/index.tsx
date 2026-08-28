import { useEffect, useState } from 'react'
import { Redirect } from 'expo-router'

import { BrandSplash } from '@/features/auth/brand-splash'
import { isDeviceUnlockEnabled } from '@/lib/device-unlock'
import { isVaultUnlocked } from '@/lib/vault-unlock'
import { loadCurrentVaultId, loadSession } from '@/sync/auth-client'

type Destination = '/welcome' | '/vaults' | '/unlock' | '/device-unlock' | '/notes'

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
      if (!unlocked) {
        if (!cancelled) setDestination('/unlock')
        return
      }
      // The biometric gate sits after the key already exists, so it is an app
      // lock rather than a second key ceremony. Off unless the user asked.
      const gated = await isDeviceUnlockEnabled()
      if (!cancelled) setDestination(gated ? '/device-unlock' : '/notes')
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
