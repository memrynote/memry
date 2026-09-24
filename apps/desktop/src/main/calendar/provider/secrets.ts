import { deleteSecret, getSecret, setSecret } from '../../secrets/secret-storage'

/**
 * Per-provider credential storage (#1394). Each provider stores its secrets
 * under its own service, `com.memry.calendar.<providerId>`, with the account
 * key scheme Google has always used: `${kind}-${accountId}`, plus the
 * `MEMRY_DEVICE` suffix for multi-profile dev runs. Google's service name and
 * keys are therefore unchanged, so existing tokens keep resolving.
 *
 * Credentials never sync: they live in this device's secret storage only.
 */
export type ProviderSecretKind = 'access-token' | 'refresh-token' | 'password'

export function providerSecretService(providerId: string): string {
  if (!/^[a-z0-9-]+$/.test(providerId)) {
    throw new Error(`Invalid calendar provider id for secret storage: ${providerId}`)
  }
  return `com.memry.calendar.${providerId}`
}

export function providerSecretAccountKey(accountId: string, kind: ProviderSecretKind): string {
  if (!accountId || !accountId.trim()) {
    throw new Error('getAccountKey requires a non-empty accountId')
  }
  const deviceSuffix = process.env.MEMRY_DEVICE
  const base = `${kind}-${accountId}`
  return deviceSuffix ? `${base}-${deviceSuffix}` : base
}

/** Store a secret, or delete it when `value` is empty. */
export async function setProviderSecret(
  providerId: string,
  accountId: string,
  kind: ProviderSecretKind,
  value: string | null
): Promise<void> {
  const service = providerSecretService(providerId)
  const account = providerSecretAccountKey(accountId, kind)
  if (!value || value.trim().length === 0) {
    await deleteSecret(service, account)
    return
  }
  await setSecret(service, account, kind === 'password' ? value : value.trim())
}

/**
 * Read a secret. An entry this device cannot decrypt reads as absent, so a
 * connect flow can always replace it (#1151): the alternative strands the
 * account, because the pre-write read would throw before the new secret is
 * ever stored.
 */
export async function getProviderSecret(
  providerId: string,
  accountId: string,
  kind: ProviderSecretKind
): Promise<string | null> {
  return await getSecret(
    providerSecretService(providerId),
    providerSecretAccountKey(accountId, kind),
    { treatUnreadableAsAbsent: true }
  )
}

export async function deleteProviderSecret(
  providerId: string,
  accountId: string,
  kind: ProviderSecretKind
): Promise<void> {
  await deleteSecret(providerSecretService(providerId), providerSecretAccountKey(accountId, kind))
}
