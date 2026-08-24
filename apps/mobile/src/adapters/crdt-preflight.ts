import type { CrdtPreflightAdapter, CrdtPreflightResult } from '@memry/sync-client/adapters'
import { vaultDir, openVaultDb } from '../db/index'
import { MOBILE_MIGRATIONS } from '../db/migrations'

/**
 * Seam 9 on mobile (T042): `PRAGMA quick_check` on the vault DB plus a
 * schema-version assert. A store that does not exist yet is healthy by
 * vacancy (fresh vault on a new device), mirroring desktop's access probe.
 */
export function createMobileCrdtPreflight(): CrdtPreflightAdapter {
  const expectedVersion = MOBILE_MIGRATIONS[MOBILE_MIGRATIONS.length - 1].version

  return {
    async verifyStoreHealth(vaultId): Promise<CrdtPreflightResult> {
      if (!vaultDir(vaultId).exists) return { ok: true }

      try {
        const db = await openVaultDb(vaultId)
        const check = await db.getFirstAsync<{ quick_check: string }>('PRAGMA quick_check')
        if (check && check.quick_check !== 'ok') {
          return { ok: false, reason: `quick_check: ${check.quick_check}` }
        }
        const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version')
        if ((version?.user_version ?? 0) > expectedVersion) {
          return {
            ok: false,
            reason: `schema version ${version?.user_version} is newer than this build supports (${expectedVersion})`
          }
        }
        return { ok: true }
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) }
      }
    }
  }
}
