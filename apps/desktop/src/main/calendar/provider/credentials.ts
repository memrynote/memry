import { deleteSecret, getSecret, setSecret } from '../../secrets/secret-storage'

/**
 * What a calendar provider can need to store.
 *
 * - `access-token` / `refresh-token` — OAuth2 (Google, Microsoft Graph)
 * - `password` — HTTP Basic / app password (CalDAV: Fastmail, Nextcloud, iCloud)
 *
 * ICS feeds have no secret at all; the URL itself is the credential and lives
 * in `calendar_sources.metadata`, not the keychain.
 */
export type ProviderSecretKind = 'access-token' | 'refresh-token' | 'password'

/**
 * One keychain service per provider. `google` resolves to
 * `com.memry.calendar.google`, byte-identical to the constant it replaces, so
 * an existing install's stored tokens keep resolving.
 */
export function calendarCredentialService(providerId: string): string {
  if (!providerId || !providerId.trim()) {
    throw new Error('calendarCredentialService requires a non-empty providerId')
  }
  return `com.memry.calendar.${providerId}`
}

/**
 * The account slot inside a provider's service. Scheme preserved verbatim from
 * the Google-only era — `${kind}-${accountId}`, with the dev-profile suffix —
 * because changing it would strand every credential already on disk.
 */
export function getProviderAccountKey(accountId: string, kind: ProviderSecretKind): string {
  if (!accountId || !accountId.trim()) {
    throw new Error('getProviderAccountKey requires a non-empty accountId')
  }
  const deviceSuffix = process.env.MEMRY_DEVICE
  const base = `${kind}-${accountId}`
  return deviceSuffix ? `${base}-${deviceSuffix}` : base
}

export async function setProviderSecret(input: {
  providerId: string
  accountId: string
  kind: ProviderSecretKind
  value: string | null
}): Promise<void> {
  const service = calendarCredentialService(input.providerId)
  const account = getProviderAccountKey(input.accountId, input.kind)

  try {
    if (!input.value || input.value.trim().length === 0) {
      await deleteSecret(service, account)
      return
    }
    await setSecret(service, account, input.value.trim())
  } catch (error) {
    throw new Error(
      `Failed to store ${input.providerId} calendar credential (${account}): ${error instanceof Error ? error.message : 'unknown error'}`
    )
  }
}

export async function getProviderSecret(input: {
  providerId: string
  accountId: string
  kind: ProviderSecretKind
}): Promise<string | null> {
  const service = calendarCredentialService(input.providerId)
  const account = getProviderAccountKey(input.accountId, input.kind)

  try {
    // Every consumer of these secrets either overwrites them (the connect flow
    // and the refresh path), deletes them (disconnect), or only asks whether
    // the account is still authorized. So an entry we cannot decrypt — the
    // profiles stranded by the v2026-08-06 app-identity rename — must read as
    // absent rather than throw, otherwise the pre-write read kills the connect
    // flow before the fresh credential is ever stored and the account can never
    // be reconnected from inside the app.
    return await getSecret(service, account, { treatUnreadableAsAbsent: true })
  } catch (error) {
    throw new Error(
      `Failed to read ${input.providerId} calendar credential (${account}): ${error instanceof Error ? error.message : 'unknown error'}`
    )
  }
}

export async function deleteProviderSecret(input: {
  providerId: string
  accountId: string
  kind: ProviderSecretKind
}): Promise<void> {
  const service = calendarCredentialService(input.providerId)
  const account = getProviderAccountKey(input.accountId, input.kind)

  try {
    await deleteSecret(service, account)
  } catch (error) {
    throw new Error(
      `Failed to delete ${input.providerId} calendar credential (${account}): ${error instanceof Error ? error.message : 'unknown error'}`
    )
  }
}
