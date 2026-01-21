/**
 * Auth Context (T063)
 * Global state management for user authentication
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useEffect,
  type ReactNode
} from 'react'
import type {
  VerifyOtpResponse,
  RequestOtpResponse,
  StartOAuthResponse
} from '@shared/contracts/ipc-sync'

export interface AuthUser {
  id: string
  email: string
}

interface SessionChangedEvent {
  isAuthenticated: boolean
  user?: { id: string; email: string }
}

export interface AuthContextValue {
  user: AuthUser | null
  isAuthenticated: boolean
  isLoading: boolean
  needsSetup: boolean
  requestOtp: (email: string) => Promise<RequestOtpResponse>
  verifyOtp: (email: string, code: string) => Promise<VerifyOtpResponse>
  resendOtp: (email: string) => Promise<RequestOtpResponse>
  startOAuth: (provider: 'google') => Promise<StartOAuthResponse>
  logout: () => Promise<void>
  refreshSession: () => Promise<void>
}

interface AuthProviderProps {
  children: ReactNode
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}

export function AuthProvider({ children }: AuthProviderProps): React.JSX.Element {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [needsSetup, setNeedsSetup] = useState(false)

  const isAuthenticated = user !== null

  useEffect(() => {
    const loadSession = async (): Promise<void> => {
      try {
        const response = await window.api.auth.getSession()
        if (response.isAuthenticated && response.user) {
          setUser({ id: response.user.id, email: response.user.email })
        } else {
          setUser(null)
        }
      } catch (error) {
        console.error('[AuthContext] Failed to load session:', error)
        setUser(null)
      } finally {
        setIsLoading(false)
      }
    }
    loadSession()
  }, [])

  useEffect(() => {
    const unsubscribeChanged = window.api.onSessionChanged((event: unknown) => {
      const sessionEvent = event as SessionChangedEvent
      if (sessionEvent.isAuthenticated && sessionEvent.user) {
        setUser({ id: sessionEvent.user.id, email: sessionEvent.user.email })
      } else {
        setUser(null)
        setNeedsSetup(false)
      }
    })

    const unsubscribeExpired = window.api.onSessionExpired(() => {
      setUser(null)
      setNeedsSetup(false)
    })

    return () => {
      unsubscribeChanged()
      unsubscribeExpired()
    }
  }, [])

  const requestOtp = useCallback(async (email: string): Promise<RequestOtpResponse> => {
    return window.api.auth.requestOtp(email)
  }, [])

  const verifyOtp = useCallback(async (email: string, code: string): Promise<VerifyOtpResponse> => {
    const response = await window.api.auth.verifyOtp(email, code)
    if (response.success) {
      if (response.needsSetup) {
        setNeedsSetup(true)
      }
    }
    return response
  }, [])

  const resendOtp = useCallback(async (email: string): Promise<RequestOtpResponse> => {
    return window.api.auth.resendOtp(email)
  }, [])

  const startOAuth = useCallback(async (provider: 'google'): Promise<StartOAuthResponse> => {
    const response = (await window.api.auth.startOAuth(provider)) as StartOAuthResponse
    if (response.success && response.isNewUser) {
      setNeedsSetup(true)
    }
    return response
  }, [])

  const logout = useCallback(async (): Promise<void> => {
    await window.api.auth.logout()
    setUser(null)
    setNeedsSetup(false)
  }, [])

  const refreshSession = useCallback(async (): Promise<void> => {
    setIsLoading(true)
    try {
      const response = await window.api.auth.getSession()
      if (response.isAuthenticated && response.user) {
        setUser({ id: response.user.id, email: response.user.email })
      } else {
        setUser(null)
      }
    } catch (error) {
      console.error('[AuthContext] Failed to refresh session:', error)
    } finally {
      setIsLoading(false)
    }
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isAuthenticated,
      isLoading,
      needsSetup,
      requestOtp,
      verifyOtp,
      resendOtp,
      startOAuth,
      logout,
      refreshSession
    }),
    [
      user,
      isAuthenticated,
      isLoading,
      needsSetup,
      requestOtp,
      verifyOtp,
      resendOtp,
      startOAuth,
      logout,
      refreshSession
    ]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export default AuthProvider
