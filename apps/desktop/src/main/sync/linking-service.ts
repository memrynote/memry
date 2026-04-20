import os from 'os'
import sodium from 'libsodium-wrappers-sumo'
import { BrowserWindow } from 'electron'

import { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'
import type {
  ApproveLinkingResult,
  CompleteLinkingQrResult,
  GenerateLinkingQrResult,
  LinkViaQrResult
} from '@memry/contracts/ipc-devices'

import {
  CBOR_FIELD_ORDER,
  computeKeyConfirm,
  computeLinkingProof,
  computeSharedSecret,
  computeVerificationCode,
  constantTimeEqual,
  decryptMasterKeyFromLinking,
  deriveLinkingKeys,
  encodeCbor,
  encryptMasterKeyForLinking,
  generateX25519KeyPair,
  getOrCreateSigningKeyPair,
  retrieveKey,
  secureCleanup
} from '../crypto'
import { getDatabase } from '../database/client'
import type { GoogleProviderAuthTransfer } from '../calendar/google/provider-auth-transfer'
import {
  collectGoogleProviderAuthTransfer,
  decryptGoogleProviderAuthTransfer,
  encryptGoogleProviderAuthTransfer,
  persistImportedGoogleProviderAuth
} from '../calendar/google/provider-auth-transfer'
import { createLogger } from '../lib/logger'

import { getFromServer, postToServer, SyncServerError } from './http-client'
import { withRetry } from './retry'

const log = createLogger('DeviceLinking')

const PLATFORM_MAP: Record<string, string> = {
  darwin: 'macos',
  win32: 'windows',
  linux: 'linux'
}

// ============================================================================
// Ephemeral State — cleared after use or on expiry
// ============================================================================

interface PendingSession {
  sessionId: string
  ephemeralPrivateKey: Uint8Array
  expiresAt: number
}

interface PendingLinkCompletion {
  sessionId: string
  encKey: Uint8Array
  macKey: Uint8Array
  setupToken: string
  expiresAt: number
}

let pendingSession: PendingSession | null = null
let pendingLinkCompletion: PendingLinkCompletion | null = null

export const clearPendingSession = (): void => {
  if (pendingSession) {
    secureCleanup(pendingSession.ephemeralPrivateKey)
    pendingSession = null
  }
}

export const clearPendingLinkCompletion = (): void => {
  if (pendingLinkCompletion) {
    secureCleanup(pendingLinkCompletion.encKey, pendingLinkCompletion.macKey)
    pendingLinkCompletion = null
  }
}

const isExpired = (expiresAt: number): boolean => Date.now() / 1000 > expiresAt

const decodeBase64 = (input: string): Uint8Array =>
  Uint8Array.from(atob(input), (ch) => ch.charCodeAt(0))

const encodeBase64 = (input: Uint8Array): string => btoa(String.fromCharCode(...input))

const toArrayBuffer = (input: Uint8Array): ArrayBuffer => Uint8Array.from(input).buffer

const computeScanProof = async (
  linkingSecret: string,
  sessionId: string,
  devicePublicKey: string
): Promise<string> => {
  const payload = encodeCbor({ sessionId, devicePublicKey }, CBOR_FIELD_ORDER.LINKING_PROOF)
  const secretBytes = decodeBase64(linkingSecret)
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(secretBytes),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', hmacKey, toArrayBuffer(payload))
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
    toArrayBuffer(secretBytes),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', hmacKey, toArrayBuffer(payload))
  return encodeBase64(new Uint8Array(signature))
}

const buildProviderAuthImportWarning = (
  failedImports: Array<{ accountId: string; error: string }>
): string | undefined => {
  if (failedImports.length === 0) {
    return undefined
  }

  const accountIds = failedImports.map(({ accountId }) => accountId).join(', ')
  return `Google Calendar needs reconnect on this device for: ${accountIds}`
}

// ============================================================================
// Flow 1: Existing device generates QR code
// ============================================================================

export const initiateDeviceLinking = async (
  accessToken: string
): Promise<GenerateLinkingQrResult> => {
  clearPendingSession()

  const keyPair = await generateX25519KeyPair()
  const ephemeralPublicKeyB64 = sodium.to_base64(keyPair.publicKey, sodium.base64_variants.ORIGINAL)

  const response = await postToServer<{
    sessionId: string
    expiresAt: number
    linkingSecret: string
  }>('/auth/linking/initiate', { ephemeralPublicKey: ephemeralPublicKeyB64 }, accessToken)

  pendingSession = {
    sessionId: response.sessionId,
    ephemeralPrivateKey: keyPair.secretKey,
    expiresAt: response.expiresAt
  }

  const qrData = JSON.stringify({
    sessionId: response.sessionId,
    ephemeralPublicKey: ephemeralPublicKeyB64,
    linkingSecret: response.linkingSecret,
    expiresAt: response.expiresAt
  })

  log.info('Linking session initiated', { sessionId: response.sessionId })

  return { qrData, sessionId: response.sessionId, expiresAt: response.expiresAt }
}

// ============================================================================
// Flow 2: New device scans QR → sends proof → waits for approval
// ============================================================================

export const linkViaQr = async (qrData: string, setupToken: string): Promise<LinkViaQrResult> => {
  clearPendingLinkCompletion()

  let parsed: {
    sessionId: string
    ephemeralPublicKey: string
    linkingSecret?: string
    expiresAt: number
  }
  try {
    parsed = JSON.parse(qrData) as typeof parsed
  } catch {
    return { success: false, error: 'Invalid QR code data' }
  }

  if (
    !parsed.sessionId ||
    !parsed.ephemeralPublicKey ||
    !parsed.expiresAt ||
    !parsed.linkingSecret
  ) {
    return { success: false, error: 'Malformed QR code data' }
  }

  if (isExpired(parsed.expiresAt)) {
    return { success: false, error: 'Linking session has expired' }
  }

  const initiatorPublicKey = sodium.from_base64(
    parsed.ephemeralPublicKey,
    sodium.base64_variants.ORIGINAL
  )

  const newDeviceKeyPair = await generateX25519KeyPair()
  const sharedSecret = await computeSharedSecret(newDeviceKeyPair.secretKey, initiatorPublicKey)
  const { encKey, macKey } = await deriveLinkingKeys(sharedSecret)

  const newDevicePublicKeyB64 = sodium.to_base64(
    newDeviceKeyPair.publicKey,
    sodium.base64_variants.ORIGINAL
  )

  const proof = computeLinkingProof(macKey, parsed.sessionId, newDevicePublicKeyB64)
  const proofB64 = sodium.to_base64(proof, sodium.base64_variants.ORIGINAL)
  const scanProof = await computeScanProof(
    parsed.linkingSecret,
    parsed.sessionId,
    newDevicePublicKeyB64
  )
  const scanConfirm = await computeScanConfirm(
    parsed.linkingSecret,
    parsed.sessionId,
    parsed.ephemeralPublicKey,
    newDevicePublicKeyB64
  )

  await postToServer('/auth/linking/scan', {
    sessionId: parsed.sessionId,
    newDevicePublicKey: newDevicePublicKeyB64,
    newDeviceConfirm: proofB64,
    linkingSecret: parsed.linkingSecret,
    scanConfirm,
    scanProof,
    deviceName: os.hostname(),
    devicePlatform: PLATFORM_MAP[process.platform] || 'linux'
  })

  const verificationCode = await computeVerificationCode(sharedSecret)

  pendingLinkCompletion = {
    sessionId: parsed.sessionId,
    encKey,
    macKey,
    setupToken,
    expiresAt: parsed.expiresAt
  }

  secureCleanup(sharedSecret, newDeviceKeyPair.secretKey)

  log.info('QR scanned, awaiting approval', { sessionId: parsed.sessionId })

  return { success: true, status: 'waiting_approval', verificationCode }
}

// ============================================================================
// Flow 3: New device completes linking after approval
// ============================================================================

export const completeLinkingQr = async (sessionId: string): Promise<CompleteLinkingQrResult> => {
  if (!pendingLinkCompletion || pendingLinkCompletion.sessionId !== sessionId) {
    return { success: false, error: 'No pending linking session found' }
  }

  if (isExpired(pendingLinkCompletion.expiresAt)) {
    clearPendingLinkCompletion()
    return { success: false, error: 'Linking session has expired' }
  }

  const { encKey, macKey, setupToken } = pendingLinkCompletion

  try {
    const { value: completeResponse } = await withRetry(
      () =>
        postToServer<{
          success: boolean
          encryptedMasterKey?: string
          encryptedKeyNonce?: string
          keyConfirm?: string
          encryptedProviderAuth?: string
          encryptedProviderAuthNonce?: string
          providerAuthConfirm?: string
          providerAuthVersion?: number
        }>('/auth/linking/complete', { sessionId }),
      { maxRetries: 3, baseDelayMs: 2000 }
    )

    if (
      !completeResponse.encryptedMasterKey ||
      !completeResponse.encryptedKeyNonce ||
      !completeResponse.keyConfirm
    ) {
      return { success: false, error: 'Session not yet approved' }
    }

    const receivedKeyConfirm = sodium.from_base64(
      completeResponse.keyConfirm,
      sodium.base64_variants.ORIGINAL
    )
    const expectedKeyConfirm = computeKeyConfirm(
      macKey,
      sessionId,
      completeResponse.encryptedMasterKey
    )

    if (!constantTimeEqual(expectedKeyConfirm, receivedKeyConfirm)) {
      log.error('Key confirmation HMAC mismatch — possible tampering')
      return { success: false, error: 'Key confirmation failed — linking data may be corrupted' }
    }

    const ciphertext = sodium.from_base64(
      completeResponse.encryptedMasterKey,
      sodium.base64_variants.ORIGINAL
    )
    const nonce = sodium.from_base64(
      completeResponse.encryptedKeyNonce,
      sodium.base64_variants.ORIGINAL
    )
    const masterKey = decryptMasterKeyFromLinking(ciphertext, nonce, encKey)
    let importedProviderAuth: GoogleProviderAuthTransfer | undefined
    let importWarning: string | undefined

    if (
      completeResponse.encryptedProviderAuth &&
      completeResponse.encryptedProviderAuthNonce &&
      completeResponse.providerAuthConfirm &&
      completeResponse.providerAuthVersion
    ) {
      try {
        importedProviderAuth = decryptGoogleProviderAuthTransfer({
          encryptedProviderAuth: completeResponse.encryptedProviderAuth,
          encryptedProviderAuthNonce: completeResponse.encryptedProviderAuthNonce,
          providerAuthConfirm: completeResponse.providerAuthConfirm,
          providerAuthVersion: completeResponse.providerAuthVersion,
          sessionId,
          encKey,
          macKey
        })
      } catch (error) {
        log.warn('Google Calendar auth transfer could not be restored during linking', {
          sessionId,
          error: error instanceof Error ? error.message : 'unknown error'
        })
        importWarning =
          'Google Calendar auth could not be restored on this device. Reconnect Google if needed.'
      }
    }

    void finalizeLinking(masterKey, setupToken, importedProviderAuth, importWarning)

    log.info('Linking approved — finalizing device registration in background')
    return { success: true }
  } catch (err) {
    if (err instanceof SyncServerError && err.statusCode === 409) {
      return { success: false, error: 'Session not yet approved' }
    }
    log.error('Failed to complete device linking', err)
    clearPendingLinkCompletion()
    throw err
  }
}

async function finalizeLinking(
  masterKey: Uint8Array,
  setupToken: string,
  importedProviderAuth?: GoogleProviderAuthTransfer,
  initialWarning?: string
): Promise<void> {
  try {
    const { value: recoveryInfo } = await withRetry(
      () =>
        getFromServer<{ kdfSalt: string; keyVerifier: string }>('/auth/recovery-info', setupToken),
      { maxRetries: 3, baseDelayMs: 2000 }
    )

    const signingKeyPair = await getOrCreateSigningKeyPair()

    const { persistKeysAndRegisterDevice } = await import('./device-registration')
    const deviceId = await persistKeysAndRegisterDevice(
      masterKey,
      signingKeyPair.secretKey,
      setupToken,
      recoveryInfo.kdfSalt,
      recoveryInfo.keyVerifier,
      true
    )

    let warning = initialWarning
    if (importedProviderAuth) {
      const result = await persistImportedGoogleProviderAuth(importedProviderAuth)
      const importWarning = buildProviderAuthImportWarning(result.failedImports)
      if (importWarning) {
        log.warn('Google Calendar auth restore completed with reconnect required', {
          accountIds: result.failedImports.map(({ accountId }) => accountId)
        })
      }
      warning = importWarning ?? warning
    }

    secureCleanup(masterKey, signingKeyPair.secretKey)
    clearPendingLinkCompletion()

    log.info('Device linking finalized', { deviceId, hadWarning: Boolean(warning) })
    emitLinkingFinalized({ deviceId, warning })
  } catch (err) {
    log.error('Background linking finalization failed', err)
    secureCleanup(masterKey)
    clearPendingLinkCompletion()
    const message = err instanceof Error ? err.message : 'Device registration failed'
    emitLinkingFinalized({ error: message })
  }
}

function emitLinkingFinalized(payload: {
  deviceId?: string
  error?: string
  warning?: string
}): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('sync:linking-finalized', payload)
  }
}

// ============================================================================
// Flow 4: Existing device approves linking request
// ============================================================================

export const approveDeviceLinking = async (
  sessionId: string,
  accessToken: string
): Promise<ApproveLinkingResult> => {
  if (!pendingSession || pendingSession.sessionId !== sessionId) {
    return { success: false, error: 'No pending linking session found for this session ID' }
  }

  if (isExpired(pendingSession.expiresAt)) {
    clearPendingSession()
    return { success: false, error: 'Linking session has expired' }
  }

  try {
    const session = await getFromServer<{
      sessionId: string
      status: string
      newDevicePublicKey: string | null
      newDeviceConfirm: string | null
      expiresAt: number
    }>(`/auth/linking/session/${sessionId}`, accessToken)

    if (!session.newDevicePublicKey || !session.newDeviceConfirm) {
      return { success: false, error: 'Session has not been scanned yet' }
    }

    const newDevicePublicKey = sodium.from_base64(
      session.newDevicePublicKey,
      sodium.base64_variants.ORIGINAL
    )
    const sharedSecret = await computeSharedSecret(
      pendingSession.ephemeralPrivateKey,
      newDevicePublicKey
    )
    const { encKey, macKey } = await deriveLinkingKeys(sharedSecret)

    const receivedConfirm = sodium.from_base64(
      session.newDeviceConfirm,
      sodium.base64_variants.ORIGINAL
    )
    const expectedConfirm = computeLinkingProof(macKey, sessionId, session.newDevicePublicKey)

    if (!constantTimeEqual(expectedConfirm, receivedConfirm)) {
      secureCleanup(sharedSecret, encKey, macKey)
      clearPendingSession()
      log.error('New device HMAC mismatch — possible tampering')
      return { success: false, error: 'Device verification failed — linking data may be corrupted' }
    }

    const masterKey = await retrieveKey(KEYCHAIN_ENTRIES.MASTER_KEY)
    if (!masterKey) {
      secureCleanup(sharedSecret, encKey, macKey)
      clearPendingSession()
      return { success: false, error: 'Master key not found in keychain' }
    }

    const { ciphertext, nonce } = encryptMasterKeyForLinking(masterKey, encKey)
    const encryptedMasterKeyB64 = sodium.to_base64(ciphertext, sodium.base64_variants.ORIGINAL)
    const encryptedKeyNonceB64 = sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL)

    const keyConfirm = computeKeyConfirm(macKey, sessionId, encryptedMasterKeyB64)
    const keyConfirmB64 = sodium.to_base64(keyConfirm, sodium.base64_variants.ORIGINAL)
    const providerAuthTransfer = await collectGoogleProviderAuthTransfer(getDatabase())
    const encryptedProviderAuth = providerAuthTransfer
      ? encryptGoogleProviderAuthTransfer({
          transfer: providerAuthTransfer,
          sessionId,
          encKey,
          macKey
        })
      : null

    await postToServer(
      '/auth/linking/approve',
      {
        sessionId,
        encryptedMasterKey: encryptedMasterKeyB64,
        encryptedKeyNonce: encryptedKeyNonceB64,
        keyConfirm: keyConfirmB64,
        ...(encryptedProviderAuth ?? {})
      },
      accessToken
    )

    secureCleanup(sharedSecret, encKey, macKey, masterKey)
    clearPendingSession()

    log.info('Device linking approved', { sessionId })
    return { success: true }
  } catch (err) {
    log.error('Failed to approve device linking', err)
    clearPendingSession()
    throw err
  }
}

// ============================================================================
// Flow 5: Existing device retrieves SAS verification code
// ============================================================================

export const getLinkingVerificationCode = async (
  sessionId: string,
  accessToken: string
): Promise<{ verificationCode?: string; error?: string }> => {
  if (!pendingSession || pendingSession.sessionId !== sessionId) {
    return { error: 'No pending linking session found' }
  }

  if (isExpired(pendingSession.expiresAt)) {
    return { error: 'Linking session has expired' }
  }

  const session = await getFromServer<{
    sessionId: string
    status: string
    newDevicePublicKey: string | null
    expiresAt: number
  }>(`/auth/linking/session/${sessionId}`, accessToken)

  if (!session.newDevicePublicKey) {
    return { error: 'Session has not been scanned yet' }
  }

  const newDevicePublicKey = sodium.from_base64(
    session.newDevicePublicKey,
    sodium.base64_variants.ORIGINAL
  )
  const sharedSecret = await computeSharedSecret(
    pendingSession.ephemeralPrivateKey,
    newDevicePublicKey
  )
  const verificationCode = await computeVerificationCode(sharedSecret)
  secureCleanup(sharedSecret)

  return { verificationCode }
}
