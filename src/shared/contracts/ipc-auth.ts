import { z } from 'zod'

// ============================================================================
// Channel Name Constants
// ============================================================================

export const AUTH_CHANNELS = {
  AUTH_REQUEST_OTP: 'auth:request-otp',
  AUTH_VERIFY_OTP: 'auth:verify-otp',
  AUTH_RESEND_OTP: 'auth:resend-otp',
  AUTH_INIT_OAUTH: 'auth:init-oauth',
  AUTH_REFRESH_TOKEN: 'auth:refresh-token',
  SETUP_FIRST_DEVICE: 'sync:setup-first-device',
  CONFIRM_RECOVERY_PHRASE: 'sync:confirm-recovery-phrase',
  AUTH_LOGOUT: 'sync:logout'
} as const

// ============================================================================
// Types
// ============================================================================

export interface RequestOtpInput {
  email: string
}

export interface RequestOtpResult {
  success: boolean
  expiresIn?: number
  message?: string
  error?: string
}

export interface VerifyOtpInput {
  email: string
  code: string
}

export interface VerifyOtpResult {
  success: boolean
  isNewUser?: boolean
  needsRecoverySetup?: boolean
  needsRecoveryInput?: boolean
  recoveryPhrase?: string
  deviceId?: string
  error?: string
}

export interface ResendOtpInput {
  email: string
}

export interface ResendOtpResult {
  success: boolean
  expiresIn?: number
  message?: string
  error?: string
}

export interface InitOAuthInput {
  provider: 'google'
}

export interface InitOAuthResult {
  state: string
}

export interface RefreshTokenResult {
  success: boolean
  error?: string
}

export interface SetupFirstDeviceInput {
  oauthToken: string
  provider: 'google'
  state: string
}

export interface SetupFirstDeviceResult {
  success: boolean
  needsRecoverySetup?: boolean
  needsRecoveryInput?: boolean
  recoveryPhrase?: string
  deviceId?: string
  error?: string
}

export interface ConfirmRecoveryPhraseInput {
  confirmed: boolean
}

export interface ConfirmRecoveryPhraseResult {
  success: boolean
}

export interface LogoutResult {
  success: boolean
}

// ============================================================================
// Zod Schemas
// ============================================================================

export const RequestOtpSchema = z.object({
  email: z.string().email()
})

export const VerifyOtpSchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/)
})

export const ResendOtpSchema = z.object({
  email: z.string().email()
})

export const InitOAuthSchema = z.object({
  provider: z.literal('google')
})

export const SetupFirstDeviceSchema = z.object({
  oauthToken: z.string().min(1),
  provider: z.literal('google'),
  state: z.string().min(1)
})

export const ConfirmRecoveryPhraseSchema = z.object({
  confirmed: z.boolean()
})

// ============================================================================
// Type Inference
// ============================================================================

export type RequestOtpSchemaInput = z.infer<typeof RequestOtpSchema>
export type VerifyOtpSchemaInput = z.infer<typeof VerifyOtpSchema>
export type ResendOtpSchemaInput = z.infer<typeof ResendOtpSchema>
export type InitOAuthSchemaInput = z.infer<typeof InitOAuthSchema>
export type SetupFirstDeviceSchemaInput = z.infer<typeof SetupFirstDeviceSchema>
export type ConfirmRecoveryPhraseSchemaInput = z.infer<typeof ConfirmRecoveryPhraseSchema>
