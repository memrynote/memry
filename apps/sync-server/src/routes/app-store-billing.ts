import { Hono } from 'hono'
import { z } from 'zod'

import { AppError, ErrorCodes } from '../lib/errors'
import { authMiddleware } from '../middleware/auth'
import { applyAppStoreTransactionForUser } from '../services/app-store-billing'
import { getBillingStatus } from '../services/paddle-billing'
import type { AppContext } from '../types'

/** Mounted at `/auth/billing/app-store`, next to the Paddle `/auth/billing*` routes. */
export const appStoreBilling = new Hono<AppContext>()

const AppStoreTransactionSchema = z.object({
  signedTransactionInfo: z.string().min(1)
})

appStoreBilling.post('/transactions', authMiddleware, async (c) => {
  const parsed = AppStoreTransactionSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid App Store transaction request', 400)
  }

  const userId = c.get('userId')!
  await applyAppStoreTransactionForUser(c.env, userId, parsed.data.signedTransactionInfo)
  return c.json(await getBillingStatus(c.env.DB, userId))
})
