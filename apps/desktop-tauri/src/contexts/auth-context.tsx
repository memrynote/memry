import {
  createContext,
  useContext,
  useReducer,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode
} from 'react'
import { authService } from '@/services/auth-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { deviceService, setupService } from '@/services/device-service'
import { invoke } from '@/lib/ipc/invoke'
import { subscribeEvent } from '@/lib/ipc/forwarder'

type AuthStatus =
  | 'idle'
  | 'checking'
  | 'unauthenticated'
  | 'authenticating'
  | 'authenticated'
  | 'error'

export type WizardStep =
  | 'idle'
  | 'sign-in'
  | 'otp-verification'
  | 'recovery-display'
  | 'recovery-confirm'
  | 'recovery-input'
  | 'linking-choice'
  | 'linking-scan'
  | 'linking-pending'

export interface WizardData {
  linkingSessionId?: string | null
  verificationCode?: string | null
  expiresAt?: number | null
  oauthState?: string | null
  error?: string | null
}

interface AuthState {
  status: AuthStatus
  email: string | null
  deviceId: string | null
  error: string | null
  needsRecoverySetup: boolean
  wizardStep: WizardStep
  wizardLinkingSessionId: string | null
  wizardVerificationCode: string | null
  wizardExpiresAt: number | null
  wizardOAuthState: string | null
  wizardError: string | null
}

export interface VerifyOtpResult {
  deviceId: string
  needsRecoverySetup: boolean
  needsRecoveryInput: boolean
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
  | { type: 'LINKING_COMPLETED'; deviceId?: string }
  | { type: 'SET_ERROR'; error: string }
  | { type: 'CLEAR_ERROR' }
  | { type: 'RESET_AUTH' }
  | { type: 'SET_AUTHENTICATING' }
  | { type: 'WIZARD_SET_STEP'; step: WizardStep; data?: WizardData }
  | { type: 'WIZARD_SET_ERROR'; error: string }
  | { type: 'WIZARD_CLEAR_ERROR' }
  | { type: 'WIZARD_RESET' }

const WIZARD_IDLE_FIELDS = {
  wizardStep: 'idle' as const,
  wizardLinkingSessionId: null,
  wizardVerificationCode: null,
  wizardExpiresAt: null,
  wizardOAuthState: null,
  wizardError: null
}

const initialState: AuthState = {
  status: 'idle',
  email: null,
  deviceId: null,
  error: null,
  needsRecoverySetup: false,
  ...WIZARD_IDLE_FIELDS
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
        error: null,
        ...WIZARD_IDLE_FIELDS
      }
    case 'CHECK_UNAUTHENTICATED':
      return { ...state, status: 'unauthenticated', wizardStep: 'sign-in', error: null }
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
        error: null,
        ...(!action.needsRecoverySetup && WIZARD_IDLE_FIELDS)
      }
    case 'RECOVERY_CONFIRMED':
      return {
        ...state,
        status: 'authenticated',
        needsRecoverySetup: false,
        ...WIZARD_IDLE_FIELDS
      }
    case 'RECOVERY_LINKED':
      return {
        ...state,
        status: 'authenticated',
        deviceId: action.deviceId,
        needsRecoverySetup: false,
        error: null,
        ...WIZARD_IDLE_FIELDS
      }
    case 'LINKING_COMPLETED':
      return {
        ...state,
        status: 'authenticated',
        deviceId: action.deviceId ?? state.deviceId,
        needsRecoverySetup: false,
        error: null,
        ...WIZARD_IDLE_FIELDS
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
      return { ...initialState, status: 'unauthenticated', wizardStep: 'sign-in' }
    case 'WIZARD_SET_STEP':
      return {
        ...state,
        wizardStep: action.step,
        wizardError: null,
        ...(action.data?.linkingSessionId !== undefined && {
          wizardLinkingSessionId: action.data.linkingSessionId
        }),
        ...(action.data?.verificationCode !== undefined && {
          wizardVerificationCode: action.data.verificationCode
        }),
        ...(action.data?.expiresAt !== undefined && {
          wizardExpiresAt: action.data.expiresAt
        }),
        ...(action.data?.oauthState !== undefined && {
          wizardOAuthState: action.data.oauthState
        })
      }
    case 'WIZARD_SET_ERROR':
      return { ...state, wizardError: action.error }
    case 'WIZARD_CLEAR_ERROR':
      return { ...state, wizardError: null }
    case 'WIZARD_RESET':
      return { ...state, ...WIZARD_IDLE_FIELDS }
    default:
      return state
  }
}

export interface SetupFirstDeviceResult {
  success: boolean
  deviceId?: string | null
  email?: string | null
  recoveryPhrase?: string[] | null
  needsRecoverySetup?: boolean | null
  needsRecoveryInput?: boolean
  error?: string | null
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
  linkingCompleted: (deviceId?: string) => void
  logout: () => Promise<void>
  clearError: () => void
  resetAuthState: () => void
  setWizardStep: (step: WizardStep, data?: WizardData) => void
  setWizardError: (error: string) => void
  clearWizardError: () => void
  resetWizard: () => void
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
  const oauthStateRef = useRef<string | null>(null)

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
    const unsubscribe = subscribeEvent<void>('session-expired', () => {
      dispatch({ type: 'RESET_AUTH' })
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    const unsubscribe = subscribeEvent<{ error: string }>('o-auth-error', ({ error }) => {
      dispatch({ type: 'SET_ERROR', error: error || 'OAuth sign-in failed' })
      dispatch({ type: 'WIZARD_SET_ERROR', error: error || 'OAuth sign-in failed' })
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    const unsubscribe = subscribeEvent<{ deviceId?: string; error?: string }>(
      'linking-finalized',
      ({ deviceId, error }) => {
        if (deviceId) {
          dispatch({ type: 'LINKING_COMPLETED', deviceId })
        } else if (error) {
          dispatch({ type: 'SET_ERROR', error })
        }
      }
    )
    return unsubscribe
  }, [])

  useEffect(() => {
    oauthStateRef.current = state.wizardOAuthState
  }, [state.wizardOAuthState])

  useEffect(() => {
    const unsubscribe = subscribeEvent<{ code: string; state: string }>(
      'o-auth-callback',
      ({ code, state: cbState }) => {
        if (cbState !== oauthStateRef.current) return
        oauthStateRef.current = null

        void (async () => {
          try {
            const result = await authService.setupFirstDevice({
              provider: 'google',
              oauthToken: code,
              state: cbState
            })
            if (result.error) {
              const message = extractErrorMessage(result.error, 'Google sign-in failed')
              dispatch({ type: 'SET_ERROR', error: message })
              dispatch({ type: 'WIZARD_SET_ERROR', error: message })
              return
            }
            dispatch({
              type: 'OTP_VERIFIED',
              deviceId: result.deviceId ?? '',
              needsRecoverySetup: !!result.needsRecoverySetup
            })
            if (result.needsRecoveryInput) {
              dispatch({ type: 'WIZARD_SET_STEP', step: 'linking-choice' })
            } else if (result.needsRecoverySetup) {
              dispatch({ type: 'WIZARD_SET_STEP', step: 'recovery-display' })
            }
          } catch (err: unknown) {
            const message = extractErrorMessage(err, 'Google sign-in failed')
            dispatch({ type: 'SET_ERROR', error: message })
            dispatch({ type: 'WIZARD_SET_ERROR', error: message })
          }
        })()
      }
    )
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
      return { expiresIn: result.expiresIn ?? undefined }
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
            needsRecoveryInput: false
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
          needsRecoveryInput: true
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
      return { expiresIn: result.expiresIn ?? undefined }
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
          needsRecoverySetup: !!result.needsRecoverySetup
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
      const result = await invoke<{ success: boolean; deviceId?: string; error?: string }>(
        'sync_linking_link_via_recovery',
        { recoveryPhrase: phrase }
      )
      if (!result.success) {
        throw new Error(extractErrorMessage(result.error, 'Recovery failed'))
      }
      dispatch({ type: 'RECOVERY_LINKED', deviceId: result.deviceId ?? '' })
      return { deviceId: result.deviceId }
    } catch (err) {
      throw new Error(extractErrorMessage(err, 'Recovery failed'))
    }
  }, [])

  const linkingCompleted = useCallback((deviceId?: string) => {
    dispatch({ type: 'LINKING_COMPLETED', deviceId })
  }, [])

  const clearError = useCallback(() => {
    dispatch({ type: 'CLEAR_ERROR' })
  }, [])

  const logout = useCallback(async (): Promise<void> => {
    try {
      await authService.logout()
    } finally {
      dispatch({ type: 'RESET_AUTH' })
    }
  }, [])

  const resetAuthState = useCallback(() => {
    dispatch({ type: 'RESET_AUTH' })
  }, [])

  const setWizardStep = useCallback((step: WizardStep, data?: WizardData) => {
    dispatch({ type: 'WIZARD_SET_STEP', step, data })
  }, [])

  const setWizardError = useCallback((error: string) => {
    dispatch({ type: 'WIZARD_SET_ERROR', error })
  }, [])

  const clearWizardError = useCallback(() => {
    dispatch({ type: 'WIZARD_CLEAR_ERROR' })
  }, [])

  const resetWizard = useCallback(() => {
    dispatch({ type: 'WIZARD_RESET' })
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
      linkingCompleted,
      logout,
      clearError,
      resetAuthState,
      setWizardStep,
      setWizardError,
      clearWizardError,
      resetWizard
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
      linkingCompleted,
      logout,
      clearError,
      resetAuthState,
      setWizardStep,
      setWizardError,
      clearWizardError,
      resetWizard
    ]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
