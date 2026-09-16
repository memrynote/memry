import type { MiddlewareHandler } from 'hono'

import { AppError, ErrorCodes } from '../lib/errors'
import {
  assertPaidSyncAccess,
  ensureLocalAdminPaidSyncAccessForUser,
  ensureSyncVaultAllowed,
  type SyncEntitlement
} from '../services/entitlements'
import type { AppContext } from '../types'

const VAULT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/

// The vault id a client that sends no `X-Memry-Vault-Id` is served under. It
// predates multi-vault, so accounts synced by those builds really do hold rows
// named exactly this and must keep resolving to them.
const LEGACY_VAULT_ID = 'default'

/**
 * Which vault a request WITHOUT `X-Memry-Vault-Id` belongs to.
 *
 * Defaulting straight to `'default'` was silently destructive: the desktop's
 * `getSyncVaultHeaders()` swallows any failure (a vault whose database is not
 * open yet) and sends no header, and `ensureSyncVaultAllowed` UPSERTS whatever
 * id it is given — so one such request mints a phantom `default` vault that
 * eats the account's vault allowance. On Plus (1 vault) that locks the user's
 * real vault out of sync permanently, reported as a 402 they cannot pay away.
 *
 * So the fallback never invents a SECOND vault:
 * - no vaults yet → `'default'`, exactly as before (first sync of a legacy build)
 * - a `'default'` row exists → that row, exactly as before (legacy account)
 * - exactly one vault → that vault; a modern client that briefly lost its
 *   header belongs there, not in a new one
 * - more than one, none of them `'default'` → unanswerable, so say so instead
 *   of guessing and consuming a slot
 */
const resolveVaultIdWithoutHeader = async (db: D1Database, userId: string): Promise<string> => {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS cnt,
              MAX(CASE WHEN vault_id = ? THEN 1 ELSE 0 END) AS hasLegacy,
              MIN(vault_id) AS onlyVaultId
       FROM sync_vaults
       WHERE user_id = ?`
    )
    .bind(LEGACY_VAULT_ID, userId)
    .first<{ cnt: number; hasLegacy: number; onlyVaultId: string | null }>()

  const count = row?.cnt ?? 0
  if (count === 0 || row?.hasLegacy === 1) return LEGACY_VAULT_ID
  if (count === 1 && row?.onlyVaultId) return row.onlyVaultId

  throw new AppError(
    ErrorCodes.VALIDATION_ERROR,
    'X-Memry-Vault-Id is required on an account with multiple vaults',
    400
  )
}

export const paidSyncMiddleware: MiddlewareHandler<AppContext> = async (c, next) => {
  const userId = c.get('userId')!
  const headerVaultId = c.req.header('X-Memry-Vault-Id') ?? c.get('vaultId')
  const vaultId = headerVaultId ?? (await resolveVaultIdWithoutHeader(c.env.DB, userId))

  if (!VAULT_ID_PATTERN.test(vaultId)) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid vault id', 400)
  }

  await ensureLocalAdminPaidSyncAccessForUser(
    c.env.DB,
    c.env.ENVIRONMENT,
    userId,
    c.env.LOCAL_ADMIN_SYNC_EMAILS
  )
  const entitlement = await assertPaidSyncAccess(c.env.DB, userId)
  await ensureSyncVaultAllowed(c.env.DB, userId, vaultId, entitlement)
  c.set('vaultId', vaultId)
  c.set('syncEntitlement', entitlement as SyncEntitlement)

  await next()
}
