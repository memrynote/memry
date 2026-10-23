// apps/landing/src/contexts/auth-context.tsx
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { SYNC_SERVER_URL } from '@/lib/account/config'
import { browserAuthStorage } from '@/lib/account/auth-storage'
import { createSyncApi } from '@/lib/account/sync-api'
import { AuthContext, type AuthState } from '@/contexts/use-auth'

export function AuthProvider({ children }: { children: ReactNode }) {
  const storage = useMemo(() => browserAuthStorage(), [])
  const [ready, setReady] = useState(false)
  const [isSignedIn, setIsSignedIn] = useState(false)
  const api = useMemo(
    () =>
      createSyncApi({
        baseUrl: SYNC_SERVER_URL,
        storage,
        onSessionCleared: () => {
          setIsSignedIn(false)
        }
      }),
    [storage]
  )

  useEffect(() => {
    // Client-only: localStorage is unavailable during SSR. Defer the read to a
    // microtask so the signed-in state lands after hydration (server renders
    // signed-out) without a synchronous setState cascade in the effect body.
    queueMicrotask(() => {
      setIsSignedIn(Boolean(storage.getSession()))
      setReady(true)
    })
  }, [storage])

  const value = useMemo<AuthState>(
    () => ({
      ready,
      isSignedIn,
      storage,
      api,
      refreshSignedIn: () => {
        setIsSignedIn(Boolean(storage.getSession()))
      },
      signOutLocal: () => {
        storage.clearSession()
        setIsSignedIn(false)
      }
    }),
    [ready, isSignedIn, storage, api]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
