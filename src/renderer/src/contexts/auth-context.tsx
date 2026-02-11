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
import { extractErrorMessage } from '@/lib/ipc-error'
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
}

export interface VerifyOtpResult {
  deviceId: string
  needsRecoverySetup: boolean
  needsRecoveryInput: boolean
  recoveryPhrase: string | null
}

type AuthAction =
  | { type: 'CHECK_START' }
  | { type: 'CHECK_AUTHENTICATED'; deviceId: string; email?: string }
  | { type: 'CHECK_UNAUTHENTICATED' }
  | { type: 'OTP_REQUESTED'; email: string }
  | {
      type: 'OTP_VERIFIED'
      deviceId: string
      needsRecoverySetup: boolean
    }
  | { type: 'RECOVERY_CONFIRMED' }
  | { type: 'RECOVERY_LINKED'; deviceId: string }
  | { type: 'SET_ERROR'; error: string }
  | { type: 'CLEAR_ERROR' }
  | { type: 'RESET_AUTH' }
  | { type: 'SET_AUTHENTICATING' }

const initialState: AuthState = {
  status: 'idle',
  email: null,
  deviceId: null,
  error: null,
  needsRecoverySetup: false
}

const authReducer = (state: AuthState, action: AuthAction): AuthState => {
  switch (action.type) {
    case 'CHECK_START':
      return { ...state, status: 'checking', error: null }
    case 'CHECK_AUTHENTICATED':
      return {
        ...state,
        status: 'authenticated',
        deviceId: action.deviceId,
        email: action.email ?? state.email,
        error: null
      }
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
        error: null
      }
    case 'RECOVERY_CONFIRMED':
      return {
        ...state,
        status: 'authenticated',
        needsRecoverySetup: false
      }
    case 'RECOVERY_LINKED':
      return {
        ...state,
        status: 'authenticated',
        deviceId: action.deviceId,
        needsRecoverySetup: false,
        error: null
      }
    case 'SET_ERROR':
      return { ...state, error: action.error, status: 'error' }
    case 'CLEAR_ERROR':
      return {
        ...state,
        error: null,
        status: state.status === 'error' ? 'unauthenticated' : state.status
      }
    case 'RESET_AUTH':
      return { ...initialState, status: 'unauthenticated' }
    default:
      return state
  }
}

export interface SetupFirstDeviceResult {
  success: boolean
  deviceId?: string
  recoveryPhrase?: string
  needsRecoveryInput?: boolean
  error?: string
}

interface AuthContextValue {
  state: AuthState
  requestOtp: (email: string) => Promise<{ expiresIn?: number }>
  verifyOtp: (code: string) => Promise<VerifyOtpResult>
  resendOtp: () => Promise<{ expiresIn?: number }>
  initOAuth: () => Promise<{ state: string } | null>
  setupFirstDevice: (input: {
    provider: 'google'
    oauthToken: string
    state: string
  }) => Promise<SetupFirstDeviceResult | null>
  confirmRecoveryPhrase: () => Promise<void>
  linkViaRecovery: (phrase: string) => Promise<{ deviceId?: string }>
  logout: () => Promise<void>
  clearError: () => void
  resetAuthState: () => void
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
          dispatch({
            type: 'CHECK_AUTHENTICATED',
            deviceId: current?.id ?? result.devices[0].id,
            email: result.email
          })
          const refreshResult = await authService.refreshToken()
          if (!refreshResult.success) {
            dispatch({ type: 'RESET_AUTH' })
          }
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
      dispatch({ type: 'RESET_AUTH' })
    })
    return unsubscribe
  }, [])

  const requestOtp = useCallback(async (email: string): Promise<{ expiresIn?: number }> => {
    dispatch({ type: 'SET_AUTHENTICATING' })
    try {
      const result = await authService.requestOtp({ email })
      if (!result.success) {
        throw new Error(extractErrorMessage(result.error, 'Failed to send verification code'))
      }
      dispatch({ type: 'OTP_REQUESTED', email })
      return { expiresIn: result.expiresIn }
    } catch (err) {
      const message = extractErrorMessage(err, 'Failed to send verification code')
      dispatch({ type: 'SET_ERROR', error: message })
      throw new Error(message)
    }
  }, [])

  const verifyOtp = useCallback(
    async (code: string): Promise<VerifyOtpResult> => {
      if (!state.email) throw new Error('No email set')
      try {
        const result = await authService.verifyOtp({ email: state.email, code })
        if (!result.success) {
          throw new Error(extractErrorMessage(result.error, 'Invalid verification code'))
        }

        if (result.needsSetup) {
          const setupResult = await authService.setupNewAccount()
          if (!setupResult.success) {
            throw new Error(extractErrorMessage(setupResult.error, 'Account setup failed'))
          }
          const otpResult: VerifyOtpResult = {
            deviceId: setupResult.deviceId ?? '',
            needsRecoverySetup: true,
            needsRecoveryInput: false,
            recoveryPhrase: setupResult.recoveryPhrase ?? null
          }
          dispatch({
            type: 'OTP_VERIFIED',
            deviceId: otpResult.deviceId,
            needsRecoverySetup: true
          })
          return otpResult
        }

        const otpResult: VerifyOtpResult = {
          deviceId: '',
          needsRecoverySetup: true,
          needsRecoveryInput: true,
          recoveryPhrase: null
        }
        dispatch({
          type: 'OTP_VERIFIED',
          deviceId: '',
          needsRecoverySetup: true
        })
        return otpResult
      } catch (err) {
        const message = extractErrorMessage(err, 'Invalid verification code')
        dispatch({ type: 'SET_ERROR', error: message })
        throw new Error(message)
      }
    },
    [state.email]
  )

  const resendOtp = useCallback(async (): Promise<{ expiresIn?: number }> => {
    if (!state.email) throw new Error('No email set')
    try {
      const result = await authService.resendOtp({ email: state.email })
      if (!result.success) {
        throw new Error(extractErrorMessage(result.error, 'Failed to resend code'))
      }
      return { expiresIn: result.expiresIn }
    } catch (err) {
      const message = extractErrorMessage(err, 'Failed to resend code')
      dispatch({ type: 'SET_ERROR', error: message })
      throw new Error(message)
    }
  }, [state.email])

  const initOAuth = useCallback(async (): Promise<{ state: string } | null> => {
    dispatch({ type: 'SET_AUTHENTICATING' })
    try {
      const result = await authService.initOAuth({ provider: 'google' })
      return result
    } catch (err) {
      dispatch({
        type: 'SET_ERROR',
        error: extractErrorMessage(err, 'Failed to start Google sign-in')
      })
      return null
    }
  }, [])

  const setupFirstDevice = useCallback(
    async (input: {
      provider: 'google'
      oauthToken: string
      state: string
    }): Promise<SetupFirstDeviceResult | null> => {
      dispatch({ type: 'SET_AUTHENTICATING' })
      try {
        const result = await authService.setupFirstDevice(input)
        if (result.error) {
          const message = extractErrorMessage(result.error, 'Failed to set up device')
          dispatch({ type: 'SET_ERROR', error: message })
          return { ...result, error: message }
        }
        dispatch({
          type: 'OTP_VERIFIED',
          deviceId: result.deviceId ?? '',
          needsRecoverySetup: !!result.recoveryPhrase
        })
        return result
      } catch (err) {
        dispatch({
          type: 'SET_ERROR',
          error: extractErrorMessage(err, 'Failed to set up device')
        })
        return null
      }
    },
    []
  )

  const confirmRecoveryPhrase = useCallback(async (): Promise<void> => {
    try {
      const result = await setupService.confirmRecoveryPhrase({ confirmed: true })
      if (!result.success) {
        throw new Error('Failed to confirm recovery phrase')
      }
      dispatch({ type: 'RECOVERY_CONFIRMED' })
    } catch (err) {
      throw new Error(extractErrorMessage(err, 'Failed to confirm recovery phrase'))
    }
  }, [])

  const linkViaRecovery = useCallback(async (phrase: string): Promise<{ deviceId?: string }> => {
    try {
      const result = await window.api.syncLinking.linkViaRecovery({ recoveryPhrase: phrase })
      if (!result.success) {
        throw new Error(extractErrorMessage(result.error, 'Recovery failed'))
      }
      dispatch({ type: 'RECOVERY_LINKED', deviceId: result.deviceId ?? '' })
      return { deviceId: result.deviceId }
    } catch (err) {
      throw new Error(extractErrorMessage(err, 'Recovery failed'))
    }
  }, [])

  const clearError = useCallback(() => {
    dispatch({ type: 'CLEAR_ERROR' })
  }, [])

  const logout = useCallback(async (): Promise<void> => {
    await authService.logout()
    dispatch({ type: 'RESET_AUTH' })
  }, [])

  const resetAuthState = useCallback(() => {
    dispatch({ type: 'RESET_AUTH' })
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      requestOtp,
      verifyOtp,
      resendOtp,
      initOAuth,
      setupFirstDevice,
      confirmRecoveryPhrase,
      linkViaRecovery,
      logout,
      clearError,
      resetAuthState
    }),
    [
      state,
      requestOtp,
      verifyOtp,
      resendOtp,
      initOAuth,
      setupFirstDevice,
      confirmRecoveryPhrase,
      linkViaRecovery,
      logout,
      clearError,
      resetAuthState
    ]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
