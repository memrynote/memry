/**
 * T104-T108: Device Linking Service
 *
 * Provides cryptographic helpers and validation utilities for the
 * device linking flow. Handles ephemeral key generation, token creation,
 * QR payload encoding, and session state management.
 */

import { LINKING_CONSTANTS, type LinkingQRPayload } from '../contracts/linking-api'

export type LinkingSessionStatus = 'pending' | 'scanned' | 'approved' | 'completed'

interface LinkingSessionRow {
  id: string
  user_id: string
  initiator_device_id: string
  ephemeral_public_key: string
  linking_token_hash: string
  new_device_public_key: string | null
  new_device_confirm: string | null
  encrypted_master_key: string | null
  encrypted_key_nonce: string | null
  key_confirm: string | null
  status: LinkingSessionStatus
  created_at: number
  expires_at: number
  completed_at: number | null
}

export type { LinkingSessionRow }

/**
 * Generate an X25519 ephemeral keypair for ECDH key exchange.
 *
 * Uses Web Crypto API which is available in Cloudflare Workers.
 * X25519 is the recommended curve for ECDH key agreement.
 *
 * @returns Object with base64-encoded public and private keys
 */
export async function generateEphemeralKeypair(): Promise<{
  publicKey: string
  privateKey: string
}> {
  const keyPair = (await crypto.subtle.generateKey('X25519', true, ['deriveBits'])) as CryptoKeyPair

  const publicKeyRaw = (await crypto.subtle.exportKey('raw', keyPair.publicKey)) as ArrayBuffer
  const privateKeyRaw = (await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)) as ArrayBuffer

  return {
    publicKey: arrayBufferToBase64(publicKeyRaw),
    privateKey: arrayBufferToBase64(privateKeyRaw)
  }
}

/**
 * Generate a cryptographically secure random token for session authentication.
 *
 * The token is included in the QR payload and used to validate that
 * the scanning device received the QR code directly from the initiator.
 *
 * @returns Base64-encoded 32-byte random token
 */
export function generateLinkingToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return arrayBufferToBase64(bytes.buffer)
}

/**
 * Encode the QR payload as a JSON string.
 *
 * The payload contains all information the new device needs to
 * initiate the scan request:
 * - sessionId: identifies the linking session
 * - token: proves the scanner received the QR directly
 * - ephemeralPublicKey: for ECDH key derivation
 * - serverUrl: where to send the scan request
 *
 * @param params - QR payload components
 * @returns JSON-encoded payload string
 */
export function encodeQRPayload(params: LinkingQRPayload): string {
  return JSON.stringify(params)
}

/**
 * Check if a linking session has expired.
 *
 * Sessions expire after LINKING_CONSTANTS.SESSION_EXPIRY_MS (10 minutes).
 * Expired sessions cannot proceed and should return a 410 Gone response.
 *
 * @param expiresAt - Session expiration timestamp in milliseconds
 * @returns True if the session has expired
 */
export function isSessionExpired(expiresAt: number): boolean {
  return expiresAt < Date.now()
}

/**
 * Calculate the expiration timestamp for a new session.
 *
 * @param createdAt - Session creation timestamp in milliseconds (defaults to now)
 * @returns Expiration timestamp in milliseconds
 */
export function calculateSessionExpiry(createdAt: number = Date.now()): number {
  return createdAt + LINKING_CONSTANTS.SESSION_EXPIRY_MS
}

/**
 * Validate a session state transition.
 *
 * The linking flow follows a strict state machine:
 * pending -> scanned -> approved -> completed
 *
 * Each operation requires the session to be in a specific state:
 * - scan: requires 'pending'
 * - approve: requires 'scanned'
 * - complete: requires 'approved'
 *
 * @param currentStatus - Current session status
 * @param expectedStatus - Required status for the operation
 * @returns True if the transition is valid
 */
export function validateStateTransition(
  currentStatus: LinkingSessionStatus,
  expectedStatus: LinkingSessionStatus
): boolean {
  return currentStatus === expectedStatus
}

/**
 * Get a linking session by ID.
 *
 * @param db - D1 database instance
 * @param sessionId - Linking session ID
 * @returns Session row or null if not found
 */
export async function getLinkingSession(
  db: D1Database,
  sessionId: string
): Promise<LinkingSessionRow | null> {
  return db
    .prepare(
      `SELECT id, user_id, initiator_device_id, ephemeral_public_key, linking_token_hash,
              new_device_public_key, new_device_confirm, encrypted_master_key,
              encrypted_key_nonce, key_confirm, status, created_at, expires_at, completed_at
       FROM linking_sessions
       WHERE id = ?`
    )
    .bind(sessionId)
    .first<LinkingSessionRow>()
}

/**
 * Create a new linking session.
 *
 * @param db - D1 database instance
 * @param params - Session creation parameters
 * @returns Created session ID
 */
export async function createLinkingSession(
  db: D1Database,
  params: {
    id: string
    userId: string
    initiatorDeviceId: string
    ephemeralPublicKey: string
    linkingTokenHash: string
    expiresAt: number
  }
): Promise<void> {
  const now = Date.now()

  await db
    .prepare(
      `INSERT INTO linking_sessions
         (id, user_id, initiator_device_id, ephemeral_public_key, linking_token_hash, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
    )
    .bind(
      params.id,
      params.userId,
      params.initiatorDeviceId,
      params.ephemeralPublicKey,
      params.linkingTokenHash,
      now,
      params.expiresAt
    )
    .run()
}

/**
 * Update session to 'scanned' state atomically.
 * Only succeeds if session is currently in 'pending' state.
 *
 * @param db - D1 database instance
 * @param sessionId - Linking session ID
 * @param newDevicePublicKey - New device's ephemeral public key
 * @param newDeviceConfirm - New device's confirmation value
 * @returns True if update succeeded, false if state was not 'pending'
 */
export async function updateSessionToScanned(
  db: D1Database,
  sessionId: string,
  newDevicePublicKey: string,
  newDeviceConfirm: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE linking_sessions
       SET new_device_public_key = ?, new_device_confirm = ?, status = 'scanned'
       WHERE id = ? AND status = 'pending'`
    )
    .bind(newDevicePublicKey, newDeviceConfirm, sessionId)
    .run()

  return (result.meta.changes ?? 0) > 0
}

/**
 * Update session to 'approved' state atomically.
 * Only succeeds if session is currently in 'scanned' state.
 *
 * @param db - D1 database instance
 * @param sessionId - Linking session ID
 * @param encryptedMasterKey - Encrypted master key
 * @param encryptedKeyNonce - Nonce used for encryption
 * @param keyConfirm - Key confirmation value
 * @returns True if update succeeded, false if state was not 'scanned'
 */
export async function updateSessionToApproved(
  db: D1Database,
  sessionId: string,
  encryptedMasterKey: string,
  encryptedKeyNonce: string,
  keyConfirm: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE linking_sessions
       SET encrypted_master_key = ?, encrypted_key_nonce = ?, key_confirm = ?, status = 'approved'
       WHERE id = ? AND status = 'scanned'`
    )
    .bind(encryptedMasterKey, encryptedKeyNonce, keyConfirm, sessionId)
    .run()

  return (result.meta.changes ?? 0) > 0
}

/**
 * Update session to 'completed' state atomically.
 * Only succeeds if session is currently in 'approved' state.
 *
 * @param db - D1 database instance
 * @param sessionId - Linking session ID
 * @returns True if update succeeded, false if state was not 'approved'
 */
export async function updateSessionToCompleted(db: D1Database, sessionId: string): Promise<boolean> {
  const now = Date.now()

  const result = await db
    .prepare(
      `UPDATE linking_sessions
       SET status = 'completed', completed_at = ?
       WHERE id = ? AND status = 'approved'`
    )
    .bind(now, sessionId)
    .run()

  return (result.meta.changes ?? 0) > 0
}

/**
 * Verify device ownership.
 *
 * @param db - D1 database instance
 * @param deviceId - Device ID to check
 * @param userId - User ID to verify against
 * @returns True if device belongs to user
 */
export async function verifyDeviceOwnership(
  db: D1Database,
  deviceId: string,
  userId: string
): Promise<boolean> {
  const device = await db
    .prepare(`SELECT user_id FROM devices WHERE id = ?`)
    .bind(deviceId)
    .first<{ user_id: string }>()

  return device?.user_id === userId
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

export async function hashLinkingToken(token: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(token)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return arrayBufferToBase64(hashBuffer)
}

export async function verifyLinkingToken(token: string, storedHash: string): Promise<boolean> {
  const tokenHash = await hashLinkingToken(token)
  return constantTimeEqual(tokenHash, storedHash)
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false

  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return result === 0
}
