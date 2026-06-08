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

export const paidSyncMiddleware: MiddlewareHandler<AppContext> = async (c, next) => {
  const userId = c.get('userId')!
  const vaultId = c.req.header('X-Memry-Vault-Id') ?? c.get('vaultId') ?? 'default'

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
