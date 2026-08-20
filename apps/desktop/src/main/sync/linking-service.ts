import os from 'os'
import sodium from 'libsodium-wrappers-sumo'
import { broadcastToAllWindows } from '../lib/window-broadcast'

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
import type { GoogleProviderAuthTransfer } from '../calendar/providers/google/provider-auth-transfer'
import {
  collectGoogleProviderAuthTransfer,
  decryptGoogleProviderAuthTransfer,
  encryptGoogleProviderAuthTransfer,
  persistImportedGoogleProviderAuth
} from '../calendar/providers/google/provider-auth-transfer'
import { createLogger } from '../lib/logger'

import { getFromServer, postToServer, RateLimitError, SyncServerError } from './http-client'
import { withRetry } from './retry'
import {
  buildVaultTransfer,
  collectVaultTransfer,
  decryptVaultTransfer,
  encryptVaultTransfer,
  type ServerVaultSummary,
  type VaultTransfer
} from './vault-transfer'
import { adoptVaultLocally } from './vault-adoption'

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

interface PendingVaultChoice {
  sessionId: string
  masterKey: Uint8Array
  setupToken: string
  importedProviderAuth?: GoogleProviderAuthTransfer
  initialWarning?: string
  vaults: VaultTransfer['vaults']
  expiresAt: number
}

let pendingSession: PendingSession | null = null
let pendingLinkCompletion: PendingLinkCompletion | null = null
let pendingVaultChoice: PendingVaultChoice | null = null

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

export const clearPendingVaultChoice = (): void => {
  if (pendingVaultChoice) {
    secureCleanup(pendingVaultChoice.masterKey)
    pendingVaultChoice = null
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
          encryptedVaultTransfer?: string
          encryptedVaultTransferNonce?: string
          vaultTransferConfirm?: string
          vaultTransferVersion?: number
        }>('/auth/linking/complete', { sessionId }),
      // This call is polled every few seconds by LinkingPending. The poll
      // cadence IS the retry, so do NOT internally retry 429 — otherwise each
      // tick spawns its own multi-attempt backoff and they pile into a storm
      // that keeps the server's rate-limit bucket saturated.
      { maxRetries: 3, baseDelayMs: 2000, retryOn429: false }
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

    let adoptedTransfer: VaultTransfer | undefined
    if (
      completeResponse.encryptedVaultTransfer &&
      completeResponse.encryptedVaultTransferNonce &&
      completeResponse.vaultTransferConfirm &&
      completeResponse.vaultTransferVersion
    ) {
      try {
        adoptedTransfer = decryptVaultTransfer({
          encryptedVaultTransfer: completeResponse.encryptedVaultTransfer,
          encryptedVaultTransferNonce: completeResponse.encryptedVaultTransferNonce,
          vaultTransferConfirm: completeResponse.vaultTransferConfirm,
          vaultTransferVersion: completeResponse.vaultTransferVersion,
          sessionId,
          encKey,
          macKey
        })
      } catch (error) {
        log.error('Vault transfer could not be decrypted during linking', {
          sessionId,
          error: error instanceof Error ? error.message : 'unknown error'
        })
        clearPendingLinkCompletion()
        return {
          success: false,
          error: 'Vault identity could not be verified — linking data may be corrupted'
        }
      }
    }

    const vaults = adoptedTransfer?.vaults ?? []
    if (vaults.length >= 2) {
      // Defer finalize: the user picks which vault(s) to pull. Ownership of the
      // decrypted master key moves to pendingVaultChoice (cleaned on finalize,
      // cancel, expiry, or error — never logged, never sent to the renderer).
      pendingVaultChoice = {
        sessionId,
        masterKey,
        setupToken,
        importedProviderAuth,
        initialWarning: importWarning,
        vaults,
        expiresAt: pendingLinkCompletion.expiresAt
      }
      clearPendingLinkCompletion()
      log.info('Multiple vaults available — deferring finalize for user choice', {
        sessionId,
        count: vaults.length
      })
      return {
        success: true,
        vaults: vaults.map((v) => ({
          vaultUuid: v.vaultUuid,
          itemCount: v.itemCount,
          createdAt: v.createdAt
        }))
      }
    }

    // Phase 1: auto-adopt the initiator's single vault.
    const adoptedVaultUuid = vaults[0]?.vaultUuid
    void finalizeLinking(
      masterKey,
      setupToken,
      adoptedVaultUuid,
      importedProviderAuth,
      importWarning
    )

    log.info('Linking approved — finalizing device registration in background')
    return { success: true }
  } catch (err) {
    if (err instanceof SyncServerError && err.statusCode === 409) {
      return { success: false, error: 'Session not yet approved' }
    }
    // 429 is transient — the next poll tick retries. Keep the pending session
    // alive (do NOT clear) so linking can still complete once the window frees.
    // The message contains "Too many requests", which LinkingPending skips on.
    if (err instanceof RateLimitError) {
      return { success: false, error: err.message }
    }
    log.error('Failed to complete device linking', err)
    clearPendingLinkCompletion()
    throw err
  }
}

async function finalizeLinking(
  masterKey: Uint8Array,
  setupToken: string,
  adoptedVaultUuid?: string,
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

    if (adoptedVaultUuid) {
      adoptVaultLocally(getDatabase(), adoptedVaultUuid)
    }

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
  broadcastToAllWindows('sync:linking-finalized', payload)
}

// ============================================================================
// Flow 3b: New device finalizes after the user picks which vault(s) to pull
// ============================================================================

export async function finalizeVaultChoice(input: {
  sessionId: string
  parentFolderPath: string
  selectedVaultUuids: string[]
  primaryVaultUuid: string
}): Promise<{ success: boolean; error?: string }> {
  if (!pendingVaultChoice || pendingVaultChoice.sessionId !== input.sessionId) {
    return { success: false, error: 'No pending vault choice for this session' }
  }
  if (isExpired(pendingVaultChoice.expiresAt)) {
    clearPendingVaultChoice()
    return { success: false, error: 'Linking session has expired' }
  }
  if (!input.selectedVaultUuids.includes(input.primaryVaultUuid)) {
    return { success: false, error: 'Primary vault must be among the selected vaults' }
  }

  const choice = pendingVaultChoice
  const { masterKey, setupToken, importedProviderAuth, initialWarning } = choice
  // Consume synchronously so a second click cannot start a concurrent finalize
  // (which would register the device twice). Provisioning failures put it back.
  pendingVaultChoice = null

  try {
    const { createDormantVault, dormantVaultFolderName } = await import('./vault-provisioning')
    const path = await import('path')
    const { selectVault } = await import('../vault')

    const primaryFolder = path.join(
      input.parentFolderPath,
      dormantVaultFolderName(input.primaryVaultUuid)
    )

    // Only the primary vault is provisioned here. The remaining account vaults
    // surface in the switcher's "In your account" section (vault directory)
    // and download on demand.
    //
    // The primary folder does not exist yet on a fresh device, and selectVault
    // validates the directory BEFORE openVault would initialize it — so it must
    // be created first. Provisioning (rather than a bare mkdir) also adopts the
    // server vault uuid into data.db before selectVault stamps the vault
    // registry, which keeps this folder matched to its account vault instead of
    // a freshly minted local uuid.
    createDormantVault(primaryFolder, input.primaryVaultUuid)

    const selected = await selectVault({ path: primaryFolder })
    if (!selected.success) {
      throw new Error(selected.error ?? 'Failed to open the primary vault')
    }
  } catch (err) {
    // Recoverable: nothing was registered yet. Restore the choice (master key
    // included — it is wiped by clearPendingVaultChoice on expiry) so the user
    // can retry from the picker, e.g. with a different parent folder, instead
    // of being stranded on a dead button until the whole link is redone.
    pendingVaultChoice = choice
    log.error('finalizeVaultChoice failed', err)
    const message = err instanceof Error ? err.message : 'Vault selection failed'
    return { success: false, error: message }
  }

  // Ownership of masterKey moves to finalizeLinking, which reports its own
  // outcome through the linking-finalized event and never throws.
  await finalizeLinking(
    masterKey,
    setupToken,
    input.primaryVaultUuid,
    importedProviderAuth,
    initialWarning
  )
  return { success: true }
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

    let transfer
    try {
      const { vaults } = await getFromServer<{ vaults: ServerVaultSummary[] }>(
        '/sync/vaults',
        accessToken
      )
      transfer =
        vaults.length > 0 ? buildVaultTransfer(vaults) : collectVaultTransfer(getDatabase())
    } catch (err) {
      log.warn('Could not enumerate account vaults; falling back to current vault', {
        error: err instanceof Error ? err.message : 'unknown'
      })
      transfer = collectVaultTransfer(getDatabase())
    }
    const vaultTransfer = encryptVaultTransfer({
      transfer,
      sessionId,
      encKey,
      macKey
    })

    await postToServer(
      '/auth/linking/approve',
      {
        sessionId,
        encryptedMasterKey: encryptedMasterKeyB64,
        encryptedKeyNonce: encryptedKeyNonceB64,
        keyConfirm: keyConfirmB64,
        ...(encryptedProviderAuth ?? {}),
        ...vaultTransfer
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
