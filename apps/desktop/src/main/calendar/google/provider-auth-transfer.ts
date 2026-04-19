import sodium from 'libsodium-wrappers-sumo'
import { z } from 'zod'

import type { DataDb } from '../../database/types'
import { computeProviderAuthConfirm, constantTimeEqual, decrypt, encrypt } from '../../crypto'
import { getGoogleCalendarTokens, storeGoogleCalendarRefreshToken } from './keychain'
import { listGoogleAccountIds } from './oauth'

const PROVIDER_AUTH_TRANSFER_VERSION = 1 as const
const PROVIDER_AUTH_AAD_PREFIX = 'google-provider-auth-transfer-v1'

const GoogleProviderAuthEntrySchema = z.object({
  provider: z.literal('google'),
  accountId: z.string().min(1),
  refreshToken: z.string().min(1)
})

const GoogleProviderAuthTransferSchema = z.object({
  version: z.literal(PROVIDER_AUTH_TRANSFER_VERSION),
  providers: z.array(GoogleProviderAuthEntrySchema)
})

export type GoogleProviderAuthTransfer = z.infer<typeof GoogleProviderAuthTransferSchema>

export interface EncryptedGoogleProviderAuthTransfer {
  encryptedProviderAuth: string
  encryptedProviderAuthNonce: string
  providerAuthConfirm: string
  providerAuthVersion: typeof PROVIDER_AUTH_TRANSFER_VERSION
}

const encodeBase64 = (input: Uint8Array): string =>
  sodium.to_base64(input, sodium.base64_variants.ORIGINAL)

const decodeBase64 = (input: string): Uint8Array =>
  sodium.from_base64(input, sodium.base64_variants.ORIGINAL)

const buildProviderAuthAad = (sessionId: string): Uint8Array =>
  new TextEncoder().encode(`${PROVIDER_AUTH_AAD_PREFIX}:${sessionId}`)

export async function collectGoogleProviderAuthTransfer(
  db: DataDb
): Promise<GoogleProviderAuthTransfer | null> {
  const providers: GoogleProviderAuthTransfer['providers'] = []

  for (const accountId of listGoogleAccountIds(db)) {
    const { refreshToken } = await getGoogleCalendarTokens(accountId)
    if (!refreshToken || refreshToken.trim().length === 0) {
      continue
    }

    providers.push({
      provider: 'google',
      accountId,
      refreshToken: refreshToken.trim()
    })
  }

  if (providers.length === 0) {
    return null
  }

  return {
    version: PROVIDER_AUTH_TRANSFER_VERSION,
    providers
  }
}

export function encryptGoogleProviderAuthTransfer(input: {
  transfer: GoogleProviderAuthTransfer
  sessionId: string
  encKey: Uint8Array
  macKey: Uint8Array
}): EncryptedGoogleProviderAuthTransfer {
  const plaintext = new TextEncoder().encode(JSON.stringify(input.transfer))
  const aad = buildProviderAuthAad(input.sessionId)
  const { ciphertext, nonce } = encrypt(plaintext, input.encKey, aad)
  const encryptedProviderAuth = encodeBase64(ciphertext)
  const providerAuthConfirm = encodeBase64(
    computeProviderAuthConfirm(input.macKey, input.sessionId, encryptedProviderAuth)
  )

  return {
    encryptedProviderAuth,
    encryptedProviderAuthNonce: encodeBase64(nonce),
    providerAuthConfirm,
    providerAuthVersion: PROVIDER_AUTH_TRANSFER_VERSION
  }
}

export function decryptGoogleProviderAuthTransfer(input: {
  encryptedProviderAuth: string
  encryptedProviderAuthNonce: string
  providerAuthConfirm: string
  providerAuthVersion: number
  sessionId: string
  encKey: Uint8Array
  macKey: Uint8Array
}): GoogleProviderAuthTransfer {
  if (input.providerAuthVersion !== PROVIDER_AUTH_TRANSFER_VERSION) {
    throw new Error(`Unsupported provider auth transfer version: ${input.providerAuthVersion}`)
  }

  const expectedConfirm = computeProviderAuthConfirm(
    input.macKey,
    input.sessionId,
    input.encryptedProviderAuth
  )
  const receivedConfirm = decodeBase64(input.providerAuthConfirm)
  if (!constantTimeEqual(expectedConfirm, receivedConfirm)) {
    throw new Error('Provider auth confirmation failed')
  }

  const aad = buildProviderAuthAad(input.sessionId)
  const plaintext = decrypt(
    decodeBase64(input.encryptedProviderAuth),
    decodeBase64(input.encryptedProviderAuthNonce),
    input.encKey,
    aad
  )

  return GoogleProviderAuthTransferSchema.parse(
    JSON.parse(new TextDecoder().decode(plaintext)) as unknown
  )
}

export async function persistImportedGoogleProviderAuth(
  transfer: GoogleProviderAuthTransfer
): Promise<{
  importedAccountIds: string[]
  failedImports: Array<{ accountId: string; error: string }>
}> {
  const importedAccountIds: string[] = []
  const failedImports: Array<{ accountId: string; error: string }> = []

  for (const provider of transfer.providers) {
    try {
      await storeGoogleCalendarRefreshToken({
        accountId: provider.accountId,
        refreshToken: provider.refreshToken
      })
      importedAccountIds.push(provider.accountId)
    } catch (error) {
      failedImports.push({
        accountId: provider.accountId,
        error: error instanceof Error ? error.message : 'Unknown provider auth import failure'
      })
    }
  }

  return { importedAccountIds, failedImports }
}
