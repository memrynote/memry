/**
 * Linking API Contracts
 *
 * Defines request/response schemas for device linking endpoints.
 * Device linking allows existing devices to securely transfer the master key
 * to new devices via QR code + encrypted channel.
 *
 * @see sync-server/src/contracts/linking-api.ts (keep in sync)
 */

import { z } from 'zod'
import { LINKING_SESSION_STATUS, DeviceSchema } from './sync-api'

// =============================================================================
// Common Schemas
// =============================================================================

const Base64Schema = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, 'Invalid Base64 string')
const UuidSchema = z.uuid()

// =============================================================================
// Constants
// =============================================================================

export const LINKING_CONSTANTS = {
  /** Session expiry: 10 minutes */
  SESSION_EXPIRY_MS: 10 * 60 * 1000,

  /** QR code refresh interval: 30 seconds */
  QR_REFRESH_INTERVAL_MS: 30 * 1000,

  /** Ephemeral key size (X25519): 32 bytes */
  EPHEMERAL_KEY_SIZE: 32
} as const

// =============================================================================
// Initiate Linking (Existing Device)
// =============================================================================

/**
 * POST /auth/linking/initiate
 * Start device linking from existing device
 *
 * Called by the existing device to create a linking session
 * and generate the QR code payload for the new device.
 */
export const LinkingInitiateRequestSchema = z.object({
  deviceId: UuidSchema
})
export type LinkingInitiateRequest = z.infer<typeof LinkingInitiateRequestSchema>

export const LinkingInitiateResponseSchema = z.object({
  sessionId: UuidSchema,
  ephemeralPublicKey: Base64Schema,
  qrPayload: z.string(),
  expiresAt: z.number().int().positive()
})
export type LinkingInitiateResponse = z.infer<typeof LinkingInitiateResponseSchema>

// =============================================================================
// Scan QR Code (New Device)
// =============================================================================

/**
 * POST /auth/linking/scan
 * New device scans QR code and submits its public key
 *
 * Called by the new device after scanning the QR code.
 * Sends the new device's ephemeral public key and HMAC proof.
 */
export const LinkingScanRequestSchema = z.object({
  sessionId: UuidSchema,
  newDevicePublicKey: Base64Schema,
  newDeviceConfirm: Base64Schema
})
export type LinkingScanRequest = z.infer<typeof LinkingScanRequestSchema>

export const LinkingScanResponseSchema = z.object({
  status: z.literal('scanned')
})
export type LinkingScanResponse = z.infer<typeof LinkingScanResponseSchema>

// =============================================================================
// Approve Linking (Existing Device)
// =============================================================================

/**
 * POST /auth/linking/approve
 * Existing device approves and transfers encrypted master key
 *
 * Called by the existing device after verifying the new device
 * via the confirmation code displayed on the new device.
 */
export const LinkingApproveRequestSchema = z.object({
  sessionId: UuidSchema,
  encryptedMasterKey: Base64Schema,
  encryptedKeyNonce: Base64Schema,
  keyConfirm: Base64Schema
})
export type LinkingApproveRequest = z.infer<typeof LinkingApproveRequestSchema>

export const LinkingApproveResponseSchema = z.object({
  status: z.literal('approved')
})
export type LinkingApproveResponse = z.infer<typeof LinkingApproveResponseSchema>

// =============================================================================
// Complete Linking (New Device)
// =============================================================================

/**
 * POST /auth/linking/complete
 * New device completes linking and receives master key
 *
 * Called by the new device after the existing device approves.
 * Returns the encrypted master key and registers the new device.
 */
export const LinkingCompleteRequestSchema = z.object({
  sessionId: UuidSchema,
  newDeviceConfirm: Base64Schema
})
export type LinkingCompleteRequest = z.infer<typeof LinkingCompleteRequestSchema>

export const LinkingCompleteResponseSchema = z.object({
  encryptedMasterKey: Base64Schema,
  encryptedKeyNonce: Base64Schema,
  keyConfirm: Base64Schema,
  device: DeviceSchema
})
export type LinkingCompleteResponse = z.infer<typeof LinkingCompleteResponseSchema>

// =============================================================================
// Session Status
// =============================================================================

/**
 * GET /auth/linking/:sessionId
 * Get linking session status
 *
 * Used by both devices to poll for status updates.
 */
export const LinkingStatusParamsSchema = z.object({
  sessionId: UuidSchema
})
export type LinkingStatusParams = z.infer<typeof LinkingStatusParamsSchema>

export const LinkingSessionSchema = z.object({
  id: UuidSchema,
  initiatorDeviceId: UuidSchema,
  ephemeralPublicKey: Base64Schema,
  newDevicePublicKey: Base64Schema.optional(),
  status: z.enum(LINKING_SESSION_STATUS),
  createdAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  completedAt: z.number().int().positive().optional()
})
export type LinkingSession = z.infer<typeof LinkingSessionSchema>

export const LinkingStatusResponseSchema = LinkingSessionSchema
export type LinkingStatusResponse = z.infer<typeof LinkingStatusResponseSchema>

// =============================================================================
// Cancel Linking
// =============================================================================

/**
 * DELETE /auth/linking/:sessionId
 * Cancel a linking session
 *
 * Can be called by either device to cancel the linking process.
 */
export const LinkingCancelParamsSchema = z.object({
  sessionId: UuidSchema
})
export type LinkingCancelParams = z.infer<typeof LinkingCancelParamsSchema>

export const LinkingCancelResponseSchema = z.object({
  success: z.boolean()
})
export type LinkingCancelResponse = z.infer<typeof LinkingCancelResponseSchema>

// =============================================================================
// QR Payload
// =============================================================================

/**
 * QR code payload structure (JSON encoded, then possibly compressed)
 */
export const LinkingQRPayloadSchema = z.object({
  sessionId: UuidSchema,
  token: z.string().min(32),
  ephemeralPublicKey: Base64Schema,
  serverUrl: z.string().url()
})
export type LinkingQRPayload = z.infer<typeof LinkingQRPayloadSchema>

// =============================================================================
// Helper Functions
// =============================================================================

export function validateLinkingInitiateRequest(data: unknown): LinkingInitiateRequest {
  return LinkingInitiateRequestSchema.parse(data)
}

export function validateLinkingScanRequest(data: unknown): LinkingScanRequest {
  return LinkingScanRequestSchema.parse(data)
}

export function validateLinkingApproveRequest(data: unknown): LinkingApproveRequest {
  return LinkingApproveRequestSchema.parse(data)
}

export function validateLinkingCompleteRequest(data: unknown): LinkingCompleteRequest {
  return LinkingCompleteRequestSchema.parse(data)
}

export function validateLinkingQRPayload(data: unknown): LinkingQRPayload {
  return LinkingQRPayloadSchema.parse(data)
}
