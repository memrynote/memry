/**
 * The vault id this device's sync requests are routed to: the
 * `X-Memry-Vault-Id` header value, and the vault a delete attestation binds
 * (#5247). `null` when the open vault's id cannot be read (a vault whose
 * database is not open yet); the request then goes without the header.
 */
export async function getSyncVaultId(): Promise<string | null> {
  try {
    // The imports stay inside the call: hoisting them to module scope would
    // pull ../database in at import time, which is exactly the eagerness the
    // lazy resolution in http-client exists to avoid. They resolve from the
    // module registry after the first call.
    const [{ getDatabase }, { getOrCreateVaultUuid }] = await Promise.all([
      import('../database'),
      import('../agent/storage/vault-id')
    ])
    // The SQLite read this used to repeat per authenticated request is now
    // cached inside getOrCreateVaultUuid, keyed on the same DataDb handle —
    // one mechanism for all eleven call sites, one invalidation hook
    // (resetVaultUuidCache) instead of a second cache to keep in step here.
    return getOrCreateVaultUuid(getDatabase()) || null
  } catch {
    return null
  }
}
