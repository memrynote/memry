/**
 * AUTO-GENERATED - DO NOT EDIT DIRECTLY
 *
 * This file is automatically copied from src/shared/contracts/auth-api.ts
 * Run `pnpm sync-contracts` to update.
 *
 * Changes should be made to the source file, not this copy.
 */

/**
 * Auth API Contracts
 *
 * Defines request/response schemas for all authentication endpoints.
 *
 * @see sync-server/src/contracts/auth-api.ts (keep in sync)
 */

import { z } from 'zod'
import { DEVICE_PLATFORMS, AUTH_PROVIDERS, DeviceSchema, UserPublicSchema } from './sync-api'

// =============================================================================
// Common Schemas
// =============================================================================

const Base64Schema = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, 'Invalid Base64 string')
const EmailSchema = z.email().max(255)

// =============================================================================
// OTP Endpoints
// =============================================================================

/**
 * POST /auth/otp/request
 * Request a one-time password for email login
 */
export const OtpRequestSchema = z.object({
  email: EmailSchema
})
export type OtpRequest = z.infer<typeof OtpRequestSchema>

export const OtpRequestResponseSchema = z.object({
  success: z.boolean(),
  expiresAt: z.number().int().positive()
})
export type OtpRequestResponse = z.infer<typeof OtpRequestResponseSchema>

/**
 * POST /auth/otp/verify
 * Verify OTP and get tokens
 */
export const OtpVerifyRequestSchema = z.object({
  email: EmailSchema,
  code: z
    .string()
    .length(6)
    .regex(/^\d{6}$/, 'OTP must be 6 digits')
})
export type OtpVerifyRequest = z.infer<typeof OtpVerifyRequestSchema>

export const OtpVerifyResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  user: UserPublicSchema,
  device: DeviceSchema.optional()
})
export type OtpVerifyResponse = z.infer<typeof OtpVerifyResponseSchema>

/**
 * POST /auth/otp/resend
 * Resend OTP code
 */
export const OtpResendRequestSchema = z.object({
  email: EmailSchema
})
export type OtpResendRequest = z.infer<typeof OtpResendRequestSchema>

export const OtpResendResponseSchema = z.object({
  success: z.boolean(),
  expiresAt: z.number().int().positive()
})
export type OtpResendResponse = z.infer<typeof OtpResendResponseSchema>

// =============================================================================
// Device Registration
// =============================================================================

/**
 * POST /auth/devices
 * Register a new device
 */
export const DeviceRegisterRequestSchema = z.object({
  name: z.string().min(1).max(100),
  platform: z.enum(DEVICE_PLATFORMS),
  osVersion: z.string().optional(),
  appVersion: z.string(),
  authPublicKey: Base64Schema,
  challengeSignature: Base64Schema,
  challengeNonce: Base64Schema
})
export type DeviceRegisterRequest = z.infer<typeof DeviceRegisterRequestSchema>

export const DeviceRegisterResponseSchema = z.object({
  device: DeviceSchema,
  challenge: z.string()
})
export type DeviceRegisterResponse = z.infer<typeof DeviceRegisterResponseSchema>

/**
 * GET /auth/devices
 * Get all devices for the authenticated user
 */
export const GetDevicesResponseSchema = z.object({
  devices: z.array(DeviceSchema)
})
export type GetDevicesResponse = z.infer<typeof GetDevicesResponseSchema>

// =============================================================================
// OAuth Endpoints
// =============================================================================

/**
 * GET /auth/oauth/:provider
 * Initiate OAuth flow - returns redirect URL
 */
export const OAuthProviderParamSchema = z.object({
  provider: z.enum(AUTH_PROVIDERS)
})
export type OAuthProviderParam = z.infer<typeof OAuthProviderParamSchema>

export const OAuthInitiateResponseSchema = z.object({
  authUrl: z.string().url(),
  state: z.string()
})
export type OAuthInitiateResponse = z.infer<typeof OAuthInitiateResponseSchema>

export const OAuthInitiateQuerySchema = z.object({
  redirect_uri: z.string().url(),
  code_challenge: z.string().min(43),
  code_challenge_method: z.literal('S256').optional(),
  state: z.string().min(8)
})
export type OAuthInitiateQuery = z.infer<typeof OAuthInitiateQuerySchema>

/**
 * GET /auth/oauth/:provider/callback
 * OAuth callback from provider
 */
export const OAuthCallbackQuerySchema = z.object({
  code: z.string(),
  state: z.string(),
  code_verifier: z.string().min(43),
  redirect_uri: z.string().url(),
  error: z.string().optional(),
  error_description: z.string().optional()
})
export type OAuthCallbackQuery = z.infer<typeof OAuthCallbackQuerySchema>

export const OAuthCallbackResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  user: UserPublicSchema,
  device: DeviceSchema,
  isNewUser: z.boolean()
})
export type OAuthCallbackResponse = z.infer<typeof OAuthCallbackResponseSchema>

// =============================================================================
// Token Refresh
// =============================================================================

/**
 * POST /auth/refresh
 * Refresh access token
 */
export const RefreshTokenRequestSchema = z.object({
  refreshToken: z.string()
})
export type RefreshTokenRequest = z.infer<typeof RefreshTokenRequestSchema>

export const RefreshTokenResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string()
})
export type RefreshTokenResponse = z.infer<typeof RefreshTokenResponseSchema>

// =============================================================================
// First Device Setup
// =============================================================================

/**
 * POST /auth/setup
 * Complete first device setup with recovery phrase derived keys
 */
export const FirstDeviceSetupRequestSchema = z.object({
  kdfSalt: Base64Schema,
  keyVerifier: Base64Schema
})
export type FirstDeviceSetupRequest = z.infer<typeof FirstDeviceSetupRequestSchema>

export const FirstDeviceSetupResponseSchema = z.object({
  success: z.boolean()
})
export type FirstDeviceSetupResponse = z.infer<typeof FirstDeviceSetupResponseSchema>

// =============================================================================
// Key Recovery
// =============================================================================

/**
 * GET /auth/recovery
 * Get recovery info (kdfSalt for master key derivation)
 */
export const RecoveryInfoResponseSchema = z.object({
  kdfSalt: Base64Schema,
  keyVerifier: Base64Schema
})
export type RecoveryInfoResponse = z.infer<typeof RecoveryInfoResponseSchema>

/**
 * POST /auth/recovery/verify
 * Verify recovery phrase by checking key verifier
 */
export const RecoveryVerifyRequestSchema = z.object({
  keyVerifier: Base64Schema
})
export type RecoveryVerifyRequest = z.infer<typeof RecoveryVerifyRequestSchema>

export const RecoveryVerifyResponseSchema = z.object({
  valid: z.boolean()
})
export type RecoveryVerifyResponse = z.infer<typeof RecoveryVerifyResponseSchema>

// =============================================================================
// Logout
// =============================================================================

/**
 * POST /auth/logout
 * Logout and revoke tokens
 */
export const LogoutRequestSchema = z.object({
  refreshToken: z.string().optional(),
  allDevices: z.boolean().optional()
})
export type LogoutRequest = z.infer<typeof LogoutRequestSchema>

export const LogoutResponseSchema = z.object({
  success: z.boolean()
})
export type LogoutResponse = z.infer<typeof LogoutResponseSchema>

// =============================================================================
// Helper Functions
// =============================================================================

export function validateOtpRequest(data: unknown): OtpRequest {
  return OtpRequestSchema.parse(data)
}

export function validateOtpVerifyRequest(data: unknown): OtpVerifyRequest {
  return OtpVerifyRequestSchema.parse(data)
}

export function validateDeviceRegisterRequest(data: unknown): DeviceRegisterRequest {
  return DeviceRegisterRequestSchema.parse(data)
}

export function validateRefreshTokenRequest(data: unknown): RefreshTokenRequest {
  return RefreshTokenRequestSchema.parse(data)
}

export function validateFirstDeviceSetupRequest(data: unknown): FirstDeviceSetupRequest {
  return FirstDeviceSetupRequestSchema.parse(data)
}
