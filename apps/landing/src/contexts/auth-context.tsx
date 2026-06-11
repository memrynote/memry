// apps/landing/src/contexts/auth-context.tsx
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { SYNC_SERVER_URL } from '@/lib/account/config'
import { browserAuthStorage, type AuthStorage } from '@/lib/account/auth-storage'
import { createSyncApi, type SyncApi } from '@/lib/account/sync-api'

interface AuthState {
  ready: boolean
  isSignedIn: boolean
  storage: AuthStorage
  api: SyncApi
  refreshSignedIn: () => void
  signOutLocal: () => void
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const storage = useMemo(() => browserAuthStorage(), [])
  const api = useMemo(() => createSyncApi({ baseUrl: SYNC_SERVER_URL, storage }), [storage])
  const [ready, setReady] = useState(false)
  const [isSignedIn, setIsSignedIn] = useState(false)

  useEffect(() => {
    // Client-only: localStorage is unavailable during SSR. Defer the read to a
    // microtask so the signed-in state lands after hydration (server renders
    // signed-out) without a synchronous setState cascade in the effect body.
    queueMicrotask(() => {
      setIsSignedIn(Boolean(storage.getSession()))
      setReady(true)
    })
  }, [storage])

  const value: AuthState = {
    ready,
    isSignedIn,
    storage,
    api,
    refreshSignedIn: () => setIsSignedIn(Boolean(storage.getSession())),
    signOutLocal: () => {
      storage.clearSession()
      setIsSignedIn(false)
    }
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
