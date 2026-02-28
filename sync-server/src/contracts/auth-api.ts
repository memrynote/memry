import { z } from 'zod'

export const RequestOtpRequestSchema = z.object({
  email: z.string().email()
})

export const VerifyOtpRequestSchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/),
  sessionNonce: z.string().min(1).optional()
})

export const ResendOtpRequestSchema = z.object({
  email: z.string().email()
})

export const DeviceRegisterRequestSchema = z.object({
  name: z.string().min(1).max(255),
  platform: z.enum(['macos', 'windows', 'linux', 'ios', 'android']),
  osVersion: z.string().optional(),
  appVersion: z.string().min(1),
  authPublicKey: z.string().min(1),
  challengeSignature: z.string().min(1),
  challengeNonce: z.string().min(1),
  sessionNonce: z.string().min(1).optional()
})

export const FirstDeviceSetupRequestSchema = z.object({
  kdfSalt: z.string().min(1),
  keyVerifier: z.string().min(1)
})

export const RefreshTokenRequestSchema = z.object({
  refreshToken: z.string().min(1)
})

export const OAuthCallbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  sessionNonce: z.string().min(1).optional()
})

export const RequestOtpResponseSchema = z.object({
  success: z.boolean(),
  expiresIn: z.number().optional(),
  message: z.string().optional()
})

export const VerifyOtpResponseSchema = z.object({
  success: z.boolean(),
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  setupToken: z.string().optional(),
  userId: z.string().optional(),
  isNewUser: z.boolean().optional(),
  needsSetup: z.boolean().optional()
})

export const DeviceRegisterResponseSchema = z.object({
  success: z.boolean(),
  deviceId: z.string().optional(),
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  error: z.string().optional()
})

export const OAuthCallbackResponseSchema = z.object({
  success: z.boolean(),
  isNewUser: z.boolean().optional(),
  needsSetup: z.boolean().optional(),
  setupToken: z.string().optional()
})

export const RecoveryDataResponseSchema = z.object({
  kdfSalt: z.string(),
  keyVerifier: z.string()
})

export const RefreshTokenResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number()
})

export type RequestOtpRequest = z.infer<typeof RequestOtpRequestSchema>
export type VerifyOtpRequest = z.infer<typeof VerifyOtpRequestSchema>
export type ResendOtpRequest = z.infer<typeof ResendOtpRequestSchema>
export type DeviceRegisterRequest = z.infer<typeof DeviceRegisterRequestSchema>
export type FirstDeviceSetupRequest = z.infer<typeof FirstDeviceSetupRequestSchema>
export type RefreshTokenRequest = z.infer<typeof RefreshTokenRequestSchema>
export type OAuthCallback = z.infer<typeof OAuthCallbackSchema>
export type RequestOtpResponse = z.infer<typeof RequestOtpResponseSchema>
export type VerifyOtpResponse = z.infer<typeof VerifyOtpResponseSchema>
export type DeviceRegisterResponse = z.infer<typeof DeviceRegisterResponseSchema>
export type OAuthCallbackResponse = z.infer<typeof OAuthCallbackResponseSchema>
export type RecoveryDataResponse = z.infer<typeof RecoveryDataResponseSchema>
export type RefreshTokenResponse = z.infer<typeof RefreshTokenResponseSchema>
