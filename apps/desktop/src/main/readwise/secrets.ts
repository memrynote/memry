import { createHash } from 'node:crypto'

import { deleteSecret, getSecret, setSecret } from '../secrets/secret-storage'

export const READWISE_SECRET_SERVICE = 'com.memry.readwise'

/**
 * The connection is per vault (D2), so the account key carries a hash of the
 * vault path. The `MEMRY_DEVICE` suffix keeps `dev:a` and `dev:b` on one Mac
 * from sharing a keychain entry, as `providerSecretAccountKey` does for
 * calendar providers. The token never syncs and never enters settings.
 */
export function readwiseTokenAccountKey(vaultPath: string): string {
  if (!vaultPath.trim()) {
    throw new Error('readwiseTokenAccountKey requires a vault path')
  }
  const scope = createHash('sha256').update(vaultPath).digest('hex').slice(0, 16)
  const base = `token-${scope}`
  const deviceSuffix = process.env.MEMRY_DEVICE
  return deviceSuffix ? `${base}-${deviceSuffix}` : base
}

export async function setReadwiseToken(vaultPath: string, token: string): Promise<void> {
  const trimmed = token.trim()
  if (!trimmed) throw new Error('Readwise token is empty')
  await setSecret(READWISE_SECRET_SERVICE, readwiseTokenAccountKey(vaultPath), trimmed)
}

/** An entry this device cannot decrypt reads as absent, so a reconnect can replace it. */
export async function getReadwiseToken(vaultPath: string): Promise<string | null> {
  return await getSecret(READWISE_SECRET_SERVICE, readwiseTokenAccountKey(vaultPath), {
    treatUnreadableAsAbsent: true
  })
}

export async function deleteReadwiseToken(vaultPath: string): Promise<void> {
  await deleteSecret(READWISE_SECRET_SERVICE, readwiseTokenAccountKey(vaultPath))
}
