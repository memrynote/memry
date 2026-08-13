import {
  deleteProviderSecret,
  getProviderAccountKey,
  getProviderSecret,
  setProviderSecret,
  type ProviderSecretKind
} from '../../provider/credentials'
import { GOOGLE_PROVIDER_ID } from './capabilities'

/**
 * Google's slot in the per-provider keychain. The service name resolves to
 * `com.memry.calendar.google` — the exact string this file used to hard-code —
 * and the account-key scheme is unchanged, so every credential already on disk
 * still resolves. No migration.
 */

/**
 * The account id used before multi-account support existed. Still read by the
 * OAuth layer when it finds a stored credential with no account attached.
 */
export const LEGACY_DEFAULT_ACCOUNT_ID = '__memry_default__'

/** Google only ever stores OAuth tokens; CalDAV's `password` is not reachable here. */
export type GoogleTokenKind = Extract<ProviderSecretKind, 'access-token' | 'refresh-token'>

export function getAccountKey(accountId: string, kind: GoogleTokenKind): string {
  return getProviderAccountKey(accountId, kind)
}

async function setPassword(
  accountId: string,
  kind: GoogleTokenKind,
  value: string | null
): Promise<void> {
  await setProviderSecret({ providerId: GOOGLE_PROVIDER_ID, accountId, kind, value })
}

async function getPassword(accountId: string, kind: GoogleTokenKind): Promise<string | null> {
  return await getProviderSecret({ providerId: GOOGLE_PROVIDER_ID, accountId, kind })
}

async function deletePassword(accountId: string, kind: GoogleTokenKind): Promise<void> {
  await deleteProviderSecret({ providerId: GOOGLE_PROVIDER_ID, accountId, kind })
}

export async function storeGoogleCalendarTokens(input: {
  accountId: string
  accessToken: string
  refreshToken: string
}): Promise<void> {
  await setPassword(input.accountId, 'access-token', input.accessToken)
  await setPassword(input.accountId, 'refresh-token', input.refreshToken)
}

export async function storeGoogleCalendarRefreshToken(input: {
  accountId: string
  refreshToken: string
}): Promise<void> {
  await setPassword(input.accountId, 'access-token', null)
  await setPassword(input.accountId, 'refresh-token', input.refreshToken)
}

export async function getGoogleCalendarTokens(accountId: string): Promise<{
  accessToken: string | null
  refreshToken: string | null
}> {
  const [accessToken, refreshToken] = await Promise.all([
    getPassword(accountId, 'access-token'),
    getPassword(accountId, 'refresh-token')
  ])

  return { accessToken, refreshToken }
}

export async function hasGoogleCalendarTokens(accountId: string): Promise<boolean> {
  const { refreshToken } = await getGoogleCalendarTokens(accountId)
  return typeof refreshToken === 'string' && refreshToken.trim().length > 0
}

export async function clearGoogleCalendarTokens(accountId: string): Promise<void> {
  await Promise.all([
    deletePassword(accountId, 'access-token'),
    deletePassword(accountId, 'refresh-token')
  ])
}
