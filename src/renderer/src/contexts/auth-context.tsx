import {
  createContext,
  useContext,
  useReducer,
  useCallback,
  useEffect,
  useMemo,
  type ReactNode
} from 'react'
import { authService } from '@/services/auth-service'
import { deviceService, setupService } from '@/services/device-service'

type AuthStatus =
  | 'idle'
  | 'checking'
  | 'unauthenticated'
  | 'authenticating'
  | 'authenticated'
  | 'error'

interface AuthState {
  status: AuthStatus
  email: string | null
  deviceId: string | null
  error: string | null
  needsRecoverySetup: boolean
  recoveryPhrase: string | null
}

type AuthAction =
  | { type: 'CHECK_START' }
  | { type: 'CHECK_AUTHENTICATED'; deviceId: string }
  | { type: 'CHECK_UNAUTHENTICATED' }
  | { type: 'OTP_REQUESTED'; email: string }
  | {
      type: 'OTP_VERIFIED'
      deviceId: string
      needsRecoverySetup: boolean
      recoveryPhrase: string | null
    }
  | { type: 'RECOVERY_CONFIRMED' }
  | { type: 'SET_ERROR'; error: string }
  | { type: 'CLEAR_ERROR' }
  | { type: 'LOGOUT' }
  | { type: 'SET_AUTHENTICATING' }

const initialState: AuthState = {
  status: 'idle',
  email: null,
  deviceId: null,
  error: null,
  needsRecoverySetup: false,
  recoveryPhrase: null
}

const authReducer = (state: AuthState, action: AuthAction): AuthState => {
  switch (action.type) {
    case 'CHECK_START':
      return { ...state, status: 'checking', error: null }
    case 'CHECK_AUTHENTICATED':
      return { ...state, status: 'authenticated', deviceId: action.deviceId, error: null }
    case 'CHECK_UNAUTHENTICATED':
      return { ...state, status: 'unauthenticated', error: null }
    case 'SET_AUTHENTICATING':
      return { ...state, status: 'authenticating', error: null }
    case 'OTP_REQUESTED':
      return { ...state, email: action.email, error: null }
    case 'OTP_VERIFIED':
      return {
        ...state,
        status: action.needsRecoverySetup ? 'authenticating' : 'authenticated',
        deviceId: action.deviceId,
        needsRecoverySetup: action.needsRecoverySetup,
        recoveryPhrase: action.recoveryPhrase,
        error: null
      }
    case 'RECOVERY_CONFIRMED':
      return {
        ...state,
        status: 'authenticated',
        needsRecoverySetup: false,
        recoveryPhrase: null
      }
    case 'SET_ERROR':
      return { ...state, error: action.error, status: 'error' }
    case 'CLEAR_ERROR':
      return {
        ...state,
        error: null,
        status: state.status === 'error' ? 'unauthenticated' : state.status
      }
    case 'LOGOUT':
      return { ...initialState, status: 'unauthenticated' }
    default:
      return state
  }
}

interface AuthContextValue {
  state: AuthState
  requestOtp: (email: string) => Promise<{ expiresIn?: number }>
  verifyOtp: (code: string) => Promise<void>
  resendOtp: () => Promise<{ expiresIn?: number }>
  confirmRecoveryPhrase: () => Promise<void>
  clearError: () => void
  logout: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export const useAuth = (): AuthContextValue => {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}

interface AuthProviderProps {
  children: ReactNode
}

export const AuthProvider = ({ children }: AuthProviderProps): React.JSX.Element => {
  const [state, dispatch] = useReducer(authReducer, initialState)

  useEffect(() => {
    const checkAuth = async (): Promise<void> => {
      dispatch({ type: 'CHECK_START' })
      try {
        const result = await deviceService.getDevices()
        if (result.devices.length > 0) {
          const current = result.devices.find((d) => d.isCurrentDevice)
          dispatch({ type: 'CHECK_AUTHENTICATED', deviceId: current?.id ?? result.devices[0].id })
        } else {
          dispatch({ type: 'CHECK_UNAUTHENTICATED' })
        }
      } catch {
        dispatch({ type: 'CHECK_UNAUTHENTICATED' })
      }
    }
    void checkAuth()
  }, [])

  useEffect(() => {
    const unsubscribe = window.api.onSessionExpired(() => {
      dispatch({ type: 'LOGOUT' })
    })
    return unsubscribe
  }, [])

  const requestOtp = useCallback(async (email: string): Promise<{ expiresIn?: number }> => {
    dispatch({ type: 'SET_AUTHENTICATING' })
    const result = await authService.requestOtp({ email })
    if (!result.success) {
      dispatch({ type: 'SET_ERROR', error: result.error ?? 'Failed to send verification code' })
      throw new Error(result.error ?? 'Failed to send verification code')
    }
    dispatch({ type: 'OTP_REQUESTED', email })
    return { expiresIn: result.expiresIn }
  }, [])

  const verifyOtp = useCallback(
    async (code: string): Promise<void> => {
      if (!state.email) throw new Error('No email set')
      const result = await authService.verifyOtp({ email: state.email, code })
      if (!result.success) {
        dispatch({ type: 'SET_ERROR', error: result.error ?? 'Invalid verification code' })
        throw new Error(result.error ?? 'Invalid verification code')
      }
      dispatch({
        type: 'OTP_VERIFIED',
        deviceId: result.deviceId ?? '',
        needsRecoverySetup: result.needsRecoverySetup ?? false,
        recoveryPhrase: result.recoveryPhrase ?? null
      })
    },
    [state.email]
  )

  const resendOtp = useCallback(async (): Promise<{ expiresIn?: number }> => {
    if (!state.email) throw new Error('No email set')
    const result = await authService.resendOtp({ email: state.email })
    if (!result.success) {
      throw new Error(result.error ?? 'Failed to resend code')
    }
    return { expiresIn: result.expiresIn }
  }, [state.email])

  const confirmRecoveryPhrase = useCallback(async (): Promise<void> => {
    const result = await setupService.confirmRecoveryPhrase({ confirmed: true })
    if (!result.success) {
      throw new Error('Failed to confirm recovery phrase')
    }
    dispatch({ type: 'RECOVERY_CONFIRMED' })
  }, [])

  const clearError = useCallback(() => {
    dispatch({ type: 'CLEAR_ERROR' })
  }, [])

  const logout = useCallback(() => {
    dispatch({ type: 'LOGOUT' })
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      requestOtp,
      verifyOtp,
      resendOtp,
      confirmRecoveryPhrase,
      clearError,
      logout
    }),
    [state, requestOtp, verifyOtp, resendOtp, confirmRecoveryPhrase, clearError, logout]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
