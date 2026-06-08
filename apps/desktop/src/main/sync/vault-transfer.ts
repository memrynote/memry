import sodium from 'libsodium-wrappers-sumo'
import { z } from 'zod'

import type { DataDb } from '../database/types'
import { computeVaultTransferConfirm, constantTimeEqual, decrypt, encrypt } from '../crypto'
import { getOrCreateVaultUuid } from '../agent/storage/vault-id'

const VAULT_TRANSFER_VERSION = 1 as const
const VAULT_TRANSFER_AAD_PREFIX = 'vault-transfer-v1'

const VaultTransferEntrySchema = z.object({
  vaultUuid: z.string().min(1),
  itemCount: z.number().int().nonnegative().optional(),
  createdAt: z.number().int().nonnegative().optional()
})

const VaultTransferSchema = z.object({
  version: z.literal(VAULT_TRANSFER_VERSION),
  vaults: z.array(VaultTransferEntrySchema).min(1)
})

export type VaultTransfer = z.infer<typeof VaultTransferSchema>

export interface EncryptedVaultTransfer {
  encryptedVaultTransfer: string
  encryptedVaultTransferNonce: string
  vaultTransferConfirm: string
  vaultTransferVersion: typeof VAULT_TRANSFER_VERSION
}

const encodeBase64 = (input: Uint8Array): string =>
  sodium.to_base64(input, sodium.base64_variants.ORIGINAL)

const decodeBase64 = (input: string): Uint8Array =>
  sodium.from_base64(input, sodium.base64_variants.ORIGINAL)

const buildAad = (sessionId: string): Uint8Array =>
  new TextEncoder().encode(`${VAULT_TRANSFER_AAD_PREFIX}:${sessionId}`)

/** Phase 1: the initiator's single current vault. Phase 2 enriches this list. */
export function collectVaultTransfer(db: DataDb): VaultTransfer {
  return {
    version: VAULT_TRANSFER_VERSION,
    vaults: [{ vaultUuid: getOrCreateVaultUuid(db) }]
  }
}

export function encryptVaultTransfer(input: {
  transfer: VaultTransfer
  sessionId: string
  encKey: Uint8Array
  macKey: Uint8Array
}): EncryptedVaultTransfer {
  const plaintext = new TextEncoder().encode(JSON.stringify(input.transfer))
  const aad = buildAad(input.sessionId)
  const { ciphertext, nonce } = encrypt(plaintext, input.encKey, aad)
  const encryptedVaultTransfer = encodeBase64(ciphertext)
  const vaultTransferConfirm = encodeBase64(
    computeVaultTransferConfirm(input.macKey, input.sessionId, encryptedVaultTransfer)
  )

  return {
    encryptedVaultTransfer,
    encryptedVaultTransferNonce: encodeBase64(nonce),
    vaultTransferConfirm,
    vaultTransferVersion: VAULT_TRANSFER_VERSION
  }
}

export function decryptVaultTransfer(input: {
  encryptedVaultTransfer: string
  encryptedVaultTransferNonce: string
  vaultTransferConfirm: string
  vaultTransferVersion: number
  sessionId: string
  encKey: Uint8Array
  macKey: Uint8Array
}): VaultTransfer {
  if (input.vaultTransferVersion !== VAULT_TRANSFER_VERSION) {
    throw new Error(`Unsupported vault transfer version: ${input.vaultTransferVersion}`)
  }

  const expectedConfirm = computeVaultTransferConfirm(
    input.macKey,
    input.sessionId,
    input.encryptedVaultTransfer
  )
  const receivedConfirm = decodeBase64(input.vaultTransferConfirm)
  if (!constantTimeEqual(expectedConfirm, receivedConfirm)) {
    throw new Error('Vault transfer confirmation failed')
  }

  const aad = buildAad(input.sessionId)
  const plaintext = decrypt(
    decodeBase64(input.encryptedVaultTransfer),
    decodeBase64(input.encryptedVaultTransferNonce),
    input.encKey,
    aad
  )

  return VaultTransferSchema.parse(JSON.parse(new TextDecoder().decode(plaintext)) as unknown)
}
