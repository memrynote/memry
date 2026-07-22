import type { Context } from 'hono'
import { Hono } from 'hono'

import { FeedbackSubmitSchema } from '@memry/contracts/feedback-api'

import { AppError, ErrorCodes } from '../lib/errors'
import { verifyAccessToken } from '../lib/jwt-verify'
import { createRateLimiter } from '../middleware/rate-limit'
import { sendEmail } from '../services/email'
import { getSyncEntitlement, isPaidSyncEntitlementActive } from '../services/entitlements'
import type { SyncPlan } from '../services/entitlements'
import type { AppContext } from '../types'

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const PLAN_LABELS: Record<SyncPlan, string> = {
  free: 'Free',
  plus: 'Plus',
  pro: 'Pro',
  believer: 'Believer'
}

interface FeedbackAccount {
  plan: SyncPlan
  paid: boolean
}

/**
 * Feedback is intentionally unauthenticated so anonymous reports still land.
 * When the desktop app does send a token we resolve the plan server-side —
 * a client-supplied plan would be trivially spoofable, and support triage
 * relies on it being true. Any failure degrades to "unknown", never a 401.
 */
const resolveAccount = async (c: Context<AppContext>): Promise<FeedbackAccount | null> => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return null

  try {
    const claims = await verifyAccessToken(authHeader.slice(7), c.env.JWT_PUBLIC_KEY)
    const entitlement = await getSyncEntitlement(c.env.DB, claims.userId)
    return { plan: entitlement.plan, paid: isPaidSyncEntitlementActive(entitlement) }
  } catch {
    return null
  }
}

const formatPlan = (account: FeedbackAccount | null): string => {
  if (!account) return 'Plan unknown (not signed in)'
  const label = PLAN_LABELS[account.plan] ?? account.plan
  return account.paid ? `${label} plan · paid` : `${label} plan · not paid`
}

const buildFeedbackHtml = (input: {
  message: string
  email?: string
  appVersion?: string
  platform?: string
  account: FeedbackAccount | null
}): string => {
  const sender = input.email ? escapeHtml(input.email) : 'anonymous'
  const meta = [
    input.appVersion ? `Version ${escapeHtml(input.appVersion)}` : null,
    input.platform ? escapeHtml(input.platform) : null,
    escapeHtml(formatPlan(input.account))
  ]
    .filter(Boolean)
    .join(' · ')

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden">
<tr><td style="background:#18181b;padding:20px 28px">
  <span style="color:#fff;font-size:16px;font-weight:600">MemryNote feedback</span>
</td></tr>
<tr><td style="padding:24px 28px">
  <p style="margin:0 0 4px;color:#71717a;font-size:13px">From</p>
  <p style="margin:0 0 16px;color:#18181b;font-size:15px;font-weight:600">${sender}</p>
  <p style="margin:0 0 4px;color:#71717a;font-size:13px">Message</p>
  <p style="margin:0;color:#18181b;font-size:15px;line-height:1.6;white-space:pre-wrap">${escapeHtml(input.message)}</p>
  ${meta ? `<hr style="border:none;border-top:1px solid #e4e4e7;margin:20px 0 12px"><p style="margin:0;color:#a1a1aa;font-size:12px">${meta}</p>` : ''}
</td></tr>
</table>
</body>
</html>`
}

export const feedback = new Hono<AppContext>()

feedback.use(
  '/',
  createRateLimiter({ maxRequests: 20, windowSeconds: 3600, keyPrefix: 'feedback' })
)

feedback.post('/', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = FeedbackSubmitSchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid feedback payload', 400)
  }

  const recipient = c.env.FEEDBACK_RECIPIENT
  if (!recipient) {
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Feedback recipient not configured', 500)
  }

  const { message, email, appVersion, platform } = parsed.data
  const account = await resolveAccount(c)
  const subject = `MemryNote feedback from ${email ?? 'anonymous'}`
  const html = buildFeedbackHtml({ message, email, appVersion, platform, account })

  await sendEmail(recipient, subject, html, c.env.RESEND_API_KEY, email, c.env)

  return c.json({ success: true }, 202)
})
