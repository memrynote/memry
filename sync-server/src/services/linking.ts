import { AppError, ErrorCodes } from '../lib/errors'
import { encodeCbor } from '../lib/cbor'
import { CBOR_FIELD_ORDER } from '../contracts/cbor-ordering'
import { constantTimeCompare } from './otp'

const SESSION_TTL_SECONDS = 300
const LINKING_SECRET_BYTES = 32

interface LinkingSessionRow {
  id: string
  user_id: string
  initiator_device_id: string
  ephemeral_public_key: string
  linking_secret_hash: string
  scanner_ip: string | null
  new_device_public_key: string | null
  new_device_confirm: string | null
  encrypted_master_key: string | null
  encrypted_key_nonce: string | null
  key_confirm: string | null
  status: string
  expires_at: number
  created_at: number
  completed_at: number | null
}

const hashLinkingSecret = async (secret: string): Promise<string> => {
  const encoded = new TextEncoder().encode(secret)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const decodeBase64 = (input: string): Uint8Array =>
  Uint8Array.from(atob(input), (ch) => ch.charCodeAt(0))

const encodeBase64 = (input: Uint8Array): string => btoa(String.fromCharCode(...input))

const computeScanProof = async (
  linkingSecret: string,
  sessionId: string,
  devicePublicKey: string
): Promise<string> => {
  const payload = encodeCbor({ sessionId, devicePublicKey }, CBOR_FIELD_ORDER.LINKING_PROOF)
  const secretBytes = decodeBase64(linkingSecret)
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', hmacKey, payload)
  return encodeBase64(new Uint8Array(signature))
}

const computeScanConfirm = async (
  linkingSecret: string,
  sessionId: string,
  initiatorPublicKey: string,
  devicePublicKey: string
): Promise<string> => {
  const payload = encodeCbor(
    { sessionId, initiatorPublicKey, devicePublicKey },
    CBOR_FIELD_ORDER.SCAN_CONFIRM
  )
  const secretBytes = decodeBase64(linkingSecret)
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', hmacKey, payload)
  return encodeBase64(new Uint8Array(signature))
}

const isSessionExpired = (session: LinkingSessionRow): boolean =>
  session.expires_at < Math.floor(Date.now() / 1000)

const assertNotExpired = (session: LinkingSessionRow): void => {
  if (isSessionExpired(session)) {
    throw new AppError(ErrorCodes.LINKING_SESSION_EXPIRED, 'Linking session has expired', 410)
  }
}

const getSession = async (db: D1Database, sessionId: string): Promise<LinkingSessionRow | null> => {
  return db
    .prepare('SELECT * FROM linking_sessions WHERE id = ?')
    .bind(sessionId)
    .first<LinkingSessionRow>()
}

const requireSession = async (db: D1Database, sessionId: string): Promise<LinkingSessionRow> => {
  const session = await getSession(db, sessionId)
  if (!session) {
    throw new AppError(ErrorCodes.LINKING_SESSION_NOT_FOUND, 'Linking session not found', 404)
  }
  return session
}

const createLinkingSession = async (
  db: D1Database,
  userId: string,
  deviceId: string,
  ephemeralPublicKey: string
): Promise<{ sessionId: string; expiresAt: number; linkingSecret: string }> => {
  const sessionId = crypto.randomUUID()
  const now = Math.floor(Date.now() / 1000)
  const expiresAt = now + SESSION_TTL_SECONDS

  const secretBytes = new Uint8Array(LINKING_SECRET_BYTES)
  crypto.getRandomValues(secretBytes)
  const linkingSecret = btoa(String.fromCharCode(...secretBytes))
  const secretHash = await hashLinkingSecret(linkingSecret)

  await db.batch([
    db
      .prepare(
        `UPDATE linking_sessions SET status = 'cancelled'
         WHERE user_id = ? AND status IN ('pending', 'scanned') AND expires_at > ?`
      )
      .bind(userId, now),
    db
      .prepare(
        `INSERT INTO linking_sessions
         (id, user_id, initiator_device_id, ephemeral_public_key, linking_secret_hash, status, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .bind(sessionId, userId, deviceId, ephemeralPublicKey, secretHash, expiresAt, now)
  ])

  return { sessionId, expiresAt, linkingSecret }
}

const transitionToScanned = async (
  db: D1Database,
  sessionId: string,
  newDevicePublicKey: string,
  newDeviceConfirm: string,
  linkingSecret: string,
  scanConfirm: string,
  scanProof: string,
  scannerIp: string | null
): Promise<{ userId: string; initiatorDeviceId: string }> => {
  const session = await requireSession(db, sessionId)
  assertNotExpired(session)

  const providedHash = await hashLinkingSecret(linkingSecret)
  const secretValid = await constantTimeCompare(providedHash, session.linking_secret_hash)
  if (!secretValid) {
    throw new AppError(
      ErrorCodes.LINKING_SECRET_INVALID,
      'Invalid linking secret. Please scan the QR code again',
      403
    )
  }

  const expectedScanProof = await computeScanProof(linkingSecret, sessionId, newDevicePublicKey)
  const scanProofValid = await constantTimeCompare(expectedScanProof, scanProof)
  if (!scanProofValid) {
    throw new AppError(
      ErrorCodes.LINKING_SECRET_INVALID,
      'Invalid linking proof. Please scan the QR code again',
      403
    )
  }

  const expectedScanConfirm = await computeScanConfirm(
    linkingSecret,
    sessionId,
    session.ephemeral_public_key,
    newDevicePublicKey
  )
  const scanConfirmValid = await constantTimeCompare(expectedScanConfirm, scanConfirm)
  if (!scanConfirmValid) {
    throw new AppError(
      ErrorCodes.LINKING_SECRET_INVALID,
      'Invalid scan confirmation. Please scan the QR code again',
      403
    )
  }

  const result = await db
    .prepare(
      `UPDATE linking_sessions
       SET status = 'scanned', new_device_public_key = ?, new_device_confirm = ?, scanner_ip = ?
       WHERE id = ? AND status = 'pending'`
    )
    .bind(newDevicePublicKey, newDeviceConfirm, scannerIp, sessionId)
    .run()

  if (!result.meta.changes) {
    const current = await getSession(db, sessionId)
    if (!current) {
      throw new AppError(
        ErrorCodes.LINKING_SESSION_NOT_FOUND,
        'This linking session has expired or was cancelled',
        404
      )
    }
    if (current.status === 'scanned') {
      throw new AppError(
        ErrorCodes.LINKING_CONCURRENT_ATTEMPT,
        'Another device has already scanned this QR code',
        409
      )
    }
    throw new AppError(
      ErrorCodes.LINKING_INVALID_TRANSITION,
      'This linking session is no longer available. Please generate a new QR code',
      409
    )
  }

  return { userId: session.user_id, initiatorDeviceId: session.initiator_device_id }
}

const transitionToApproved = async (
  db: D1Database,
  sessionId: string,
  userId: string,
  encryptedMasterKey: string,
  encryptedKeyNonce: string,
  keyConfirm: string
): Promise<void> => {
  const session = await requireSession(db, sessionId)
  assertNotExpired(session)

  if (session.user_id !== userId) {
    throw new AppError(
      ErrorCodes.LINKING_INVALID_TRANSITION,
      'Not authorized to approve this session',
      409
    )
  }

  const result = await db
    .prepare(
      `UPDATE linking_sessions
       SET status = 'approved', encrypted_master_key = ?, encrypted_key_nonce = ?, key_confirm = ?
       WHERE id = ? AND status = 'scanned'`
    )
    .bind(encryptedMasterKey, encryptedKeyNonce, keyConfirm, sessionId)
    .run()

  if (!result.meta.changes) {
    const current = await getSession(db, sessionId)
    if (!current) {
      throw new AppError(
        ErrorCodes.LINKING_SESSION_NOT_FOUND,
        'This linking session has expired or was cancelled',
        404
      )
    }
    if (current.status === 'approved') {
      throw new AppError(
        ErrorCodes.LINKING_CONCURRENT_ATTEMPT,
        'This session was already approved from another device',
        409
      )
    }
    throw new AppError(
      ErrorCodes.LINKING_INVALID_TRANSITION,
      'This linking session is no longer available. Please start again',
      409
    )
  }
}

const transitionToCompleted = async (
  db: D1Database,
  sessionId: string,
  callerIp: string | null
): Promise<{ encryptedMasterKey: string; encryptedKeyNonce: string; keyConfirm: string }> => {
  const session = await requireSession(db, sessionId)
  assertNotExpired(session)

  if (session.scanner_ip && callerIp && session.scanner_ip !== callerIp) {
    throw new AppError(
      ErrorCodes.LINKING_IP_MISMATCH,
      'Request must come from the same device that scanned the QR code',
      403
    )
  }

  const now = Math.floor(Date.now() / 1000)
  const result = await db
    .prepare(
      `UPDATE linking_sessions
       SET status = 'completed', completed_at = ?
       WHERE id = ? AND status = 'approved'`
    )
    .bind(now, sessionId)
    .run()

  if (!result.meta.changes) {
    const current = await getSession(db, sessionId)
    if (!current) {
      throw new AppError(
        ErrorCodes.LINKING_SESSION_NOT_FOUND,
        'This linking session has expired or was cancelled',
        404
      )
    }
    if (current.status === 'completed') {
      throw new AppError(
        ErrorCodes.LINKING_CONCURRENT_ATTEMPT,
        'This device has already been linked',
        409
      )
    }
    throw new AppError(
      ErrorCodes.LINKING_INVALID_TRANSITION,
      'This linking session is no longer available. Please start again',
      409
    )
  }

  return {
    encryptedMasterKey: session.encrypted_master_key!,
    encryptedKeyNonce: session.encrypted_key_nonce!,
    keyConfirm: session.key_confirm!
  }
}

export {
  createLinkingSession,
  getSession,
  hashLinkingSecret,
  requireSession,
  isSessionExpired,
  transitionToScanned,
  transitionToApproved,
  transitionToCompleted
}
export type { LinkingSessionRow }
