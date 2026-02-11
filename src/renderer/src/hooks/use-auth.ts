import { useCallback, useEffect, useReducer, useRef } from 'react'
import { authService } from '@/services/auth-service'

type AuthStatus = 'idle' | 'otp_requested' | 'authenticated' | 'session_expired'

interface AuthState {
  status: AuthStatus
  isLoading: boolean
  error: string | null
  email: string | null
  isNewUser: boolean | null
  needsRecoverySetup: boolean
  recoveryPhrase: string | null
  deviceId: string | null
  detectedOtp: string | null
}

type AuthAction =
  | { type: 'LOADING' }
  | { type: 'DONE_LOADING' }
  | { type: 'OTP_REQUESTED'; email: string }
  | {
      type: 'OTP_VERIFIED'
      isNewUser: boolean
      needsRecoverySetup: boolean
      recoveryPhrase?: string
      deviceId?: string
    }
  | { type: 'RECOVERY_CONFIRMED' }
  | { type: 'SESSION_EXPIRED' }
  | { type: 'ERROR'; error: string }
  | { type: 'CLEAR_ERROR' }
  | { type: 'OTP_DETECTED'; code: string }
  | { type: 'CLEAR_DETECTED_OTP' }
  | { type: 'RESET' }

const initialState: AuthState = {
  status: 'idle',
  isLoading: false,
  error: null,
  email: null,
  isNewUser: null,
  needsRecoverySetup: false,
  recoveryPhrase: null,
  deviceId: null,
  detectedOtp: null
}

const authReducer = (state: AuthState, action: AuthAction): AuthState => {
  switch (action.type) {
    case 'LOADING':
      return { ...state, isLoading: true, error: null }
    case 'DONE_LOADING':
      return { ...state, isLoading: false }
    case 'OTP_REQUESTED':
      return { ...state, isLoading: false, status: 'otp_requested', email: action.email }
    case 'OTP_VERIFIED':
      return {
        ...state,
        isLoading: false,
        status: 'authenticated',
        isNewUser: action.isNewUser,
        needsRecoverySetup: action.needsRecoverySetup,
        recoveryPhrase: action.recoveryPhrase ?? null,
        deviceId: action.deviceId ?? null
      }
    case 'RECOVERY_CONFIRMED':
      return { ...state, isLoading: false, needsRecoverySetup: false, recoveryPhrase: null }
    case 'SESSION_EXPIRED':
      return { ...initialState, status: 'session_expired' }
    case 'ERROR':
      return { ...state, isLoading: false, error: action.error }
    case 'CLEAR_ERROR':
      return { ...state, error: null }
    case 'OTP_DETECTED':
      return { ...state, detectedOtp: action.code }
    case 'CLEAR_DETECTED_OTP':
      return { ...state, detectedOtp: null }
    case 'RESET':
      return initialState
  }
}

export const useAuth = () => {
  const [state, dispatch] = useReducer(authReducer, initialState)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    const unsubExpired = window.api.onSessionExpired(() => {
      if (mountedRef.current) dispatch({ type: 'SESSION_EXPIRED' })
    })

    const unsubOtp = window.api.onOtpDetected((event) => {
      if (mountedRef.current) dispatch({ type: 'OTP_DETECTED', code: event.code })
    })

    return () => {
      unsubExpired()
      unsubOtp()
    }
  }, [])

  const requestOtp = useCallback(async (email: string) => {
    dispatch({ type: 'LOADING' })
    try {
      const result = await authService.requestOtp({ email })
      if (!mountedRef.current) return
      if (result.error) {
        dispatch({ type: 'ERROR', error: result.error })
        return
      }
      dispatch({ type: 'OTP_REQUESTED', email })
    } catch (err) {
      if (!mountedRef.current) return
      dispatch({
        type: 'ERROR',
        error: err instanceof Error ? err.message : 'Failed to request OTP'
      })
    }
  }, [])

  const verifyOtp = useCallback(async (email: string, code: string) => {
    dispatch({ type: 'LOADING' })
    try {
      const result = await authService.verifyOtp({ email, code })
      if (!mountedRef.current) return
      if (result.error) {
        dispatch({ type: 'ERROR', error: result.error })
        return
      }
      dispatch({
        type: 'OTP_VERIFIED',
        isNewUser: result.isNewUser ?? false,
        needsRecoverySetup: result.needsRecoverySetup ?? false,
        recoveryPhrase: result.recoveryPhrase,
        deviceId: result.deviceId
      })
    } catch (err) {
      if (!mountedRef.current) return
      dispatch({
        type: 'ERROR',
        error: err instanceof Error ? err.message : 'Failed to verify OTP'
      })
    }
  }, [])

  const resendOtp = useCallback(async (email: string) => {
    dispatch({ type: 'LOADING' })
    try {
      const result = await authService.resendOtp({ email })
      if (!mountedRef.current) return
      if (result.error) {
        dispatch({ type: 'ERROR', error: result.error })
        return
      }
      dispatch({ type: 'OTP_REQUESTED', email })
    } catch (err) {
      if (!mountedRef.current) return
      dispatch({
        type: 'ERROR',
        error: err instanceof Error ? err.message : 'Failed to resend OTP'
      })
    }
  }, [])

  const initOAuth = useCallback(async () => {
    dispatch({ type: 'LOADING' })
    try {
      const result = await authService.initOAuth({ provider: 'google' })
      if (!mountedRef.current) return null
      dispatch({ type: 'DONE_LOADING' })
      return result
    } catch (err) {
      if (!mountedRef.current) return null
      dispatch({
        type: 'ERROR',
        error: err instanceof Error ? err.message : 'Failed to init OAuth'
      })
      return null
    }
  }, [])

  const refreshToken = useCallback(async (): Promise<boolean> => {
    try {
      const result = await authService.refreshToken()
      if (!mountedRef.current) return false
      if (!result.success) {
        dispatch({ type: 'SESSION_EXPIRED' })
        return false
      }
      return true
    } catch {
      if (!mountedRef.current) return false
      dispatch({ type: 'SESSION_EXPIRED' })
      return false
    }
  }, [])

  const setupFirstDevice = useCallback(
    async (input: { provider: 'google'; oauthToken: string; state: string }) => {
      dispatch({ type: 'LOADING' })
      try {
        const result = await authService.setupFirstDevice(input)
        if (!mountedRef.current) return
        if (result.error) {
          dispatch({ type: 'ERROR', error: result.error })
          return
        }
        dispatch({
          type: 'OTP_VERIFIED',
          isNewUser: true,
          needsRecoverySetup: !!result.recoveryPhrase,
          recoveryPhrase: result.recoveryPhrase,
          deviceId: result.deviceId
        })
      } catch (err) {
        if (!mountedRef.current) return
        dispatch({
          type: 'ERROR',
          error: err instanceof Error ? err.message : 'Failed to set up device'
        })
      }
    },
    []
  )

  const confirmRecoveryPhrase = useCallback(async () => {
    dispatch({ type: 'LOADING' })
    try {
      await authService.confirmRecoveryPhrase({ confirmed: true })
      if (!mountedRef.current) return
      dispatch({ type: 'RECOVERY_CONFIRMED' })
    } catch (err) {
      if (!mountedRef.current) return
      dispatch({
        type: 'ERROR',
        error: err instanceof Error ? err.message : 'Failed to confirm recovery phrase'
      })
    }
  }, [])

  const clearError = useCallback(() => dispatch({ type: 'CLEAR_ERROR' }), [])
  const clearDetectedOtp = useCallback(() => dispatch({ type: 'CLEAR_DETECTED_OTP' }), [])
  const reset = useCallback(() => dispatch({ type: 'RESET' }), [])

  return {
    ...state,
    requestOtp,
    verifyOtp,
    resendOtp,
    initOAuth,
    setupFirstDevice,
    refreshToken,
    confirmRecoveryPhrase,
    clearError,
    clearDetectedOtp,
    reset
  }
}
