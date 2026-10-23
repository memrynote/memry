import { createContext, useContext } from 'react'
import type { AuthStorage } from '@/lib/account/auth-storage'
import type { SyncApi } from '@/lib/account/sync-api'

export interface AuthState {
  ready: boolean
  isSignedIn: boolean
  storage: AuthStorage
  api: SyncApi
  refreshSignedIn: () => void
  signOutLocal: () => void
}

export const AuthContext = createContext<AuthState | null>(null)

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
