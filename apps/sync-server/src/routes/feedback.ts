import type { Context } from 'hono'
import { Hono } from 'hono'

import { FeedbackSubmitSchema } from '@memry/contracts/feedback-api'
import type { FeedbackSubmit } from '@memry/contracts/feedback-api'

import { safeBase64Encode } from '../lib/encoding'
import { AppError, ErrorCodes } from '../lib/errors'
import { verifyAccessToken } from '../lib/jwt-verify'
import { createLogger } from '../lib/logger'
import { createRateLimiter } from '../middleware/rate-limit'
import { sendEmail } from '../services/email'
import type { EmailAttachment } from '../services/email'
import { getSyncEntitlement, isPaidSyncEntitlementActive } from '../services/entitlements'
import type { SyncPlan } from '../services/entitlements'
import type { AppContext } from '../types'

const logger = createLogger('Feedback')

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const PLAN_LABELS: Record<SyncPlan, string> = {
  free: 'Free',
  plus: 'Plus',
  pro: 'Pro',
  believer: 'Believer'
}

interface FeedbackAccount {
  userId: string
  email: string | null
  plan: SyncPlan
  paid: boolean
}

/**
 * Feedback is intentionally unauthenticated so anonymous reports still land.
 * When the app does send a token we resolve the account and plan server-side —
 * client-supplied values would be trivially spoofable, and support triage
 * relies on them being true. Any failure degrades to "unknown", never a 401.
 */
const resolveAccount = async (c: Context<AppContext>): Promise<FeedbackAccount | null> => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return null

  try {
    const claims = await verifyAccessToken(authHeader.slice(7), c.env.JWT_PUBLIC_KEY)
    const [entitlement, email] = await Promise.all([
      getSyncEntitlement(c.env.DB, claims.userId),
      lookupEmail(c.env.DB, claims.userId)
    ])
    return {
      userId: claims.userId,
      email,
      plan: entitlement.plan,
      paid: isPaidSyncEntitlementActive(entitlement)
    }
  } catch {
    return null
  }
}

/** The account's email, or `null` so a failed read still leaves the plan on the email. */
const lookupEmail = async (db: D1Database, userId: string): Promise<string | null> => {
  try {
    const user = await db
      .prepare('SELECT email FROM users WHERE id = ?')
      .bind(userId)
      .first<{ email: string }>()
    return user?.email ?? null
  } catch (error) {
    logger.warn('Feedback account email lookup failed', {
      error: error instanceof Error ? error.message : String(error)
    })
    return null
  }
}

const formatPlan = (account: FeedbackAccount | null): string => {
  if (!account) return 'Plan unknown (not signed in)'
  const label = PLAN_LABELS[account.plan] ?? account.plan
  return account.paid ? `${label} plan · paid` : `${label} plan · not paid`
}

const formatAccount = (account: FeedbackAccount | null): string => {
  if (!account) return 'Not signed in'
  return `${account.email ?? 'email unknown'} · user ${account.userId}`
}

/** `2026-11-19T03:47:12.000Z` -> `2026-11-19 03:47:12 UTC`. */
const formatUtc = (date: Date): string => `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`

const formatApp = (input: FeedbackSubmit): string | null => {
  if (!input.appVersion) return input.appBuild ? `Build ${input.appBuild}` : null
  return input.appBuild
    ? `Version ${input.appVersion} (build ${input.appBuild})`
    : `Version ${input.appVersion}`
}

const formatSystem = (input: FeedbackSubmit): string | null =>
  [input.platform, input.osVersion, input.deviceModel].filter(Boolean).join(' · ') || null

const formatSize = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`

interface LogsAttachment extends EmailAttachment {
  bytes: number
}

/** `memrynote-logs-20261119T034712Z.txt`, stamped with the submission time. */
const logsAttachment = (logs: string, submittedAt: Date): LogsAttachment => {
  const bytes = new TextEncoder().encode(logs)
  const stamp = submittedAt.toISOString().slice(0, 19).replace(/[-:]/g, '')
  return {
    filename: `memrynote-logs-${stamp}Z.txt`,
    content: safeBase64Encode(bytes),
    bytes: bytes.byteLength
  }
}

const detailRow = (label: string, value: string): string =>
  `<tr><td style="padding:2px 12px 2px 0;color:#a1a1aa;font-size:12px;vertical-align:top;white-space:nowrap">${escapeHtml(label)}</td><td style="padding:2px 0;color:#52525b;font-size:12px">${escapeHtml(value)}</td></tr>`

const buildFeedbackHtml = (input: {
  /** The reply address: the typed email, else the verified account's. */
  from: string | undefined
  submission: FeedbackSubmit
  account: FeedbackAccount | null
  submittedAt: Date
  logs: LogsAttachment | null
}): string => {
  const { from, submission, account, submittedAt, logs } = input
  const sender = from ? escapeHtml(from) : 'anonymous'
  const app = formatApp(submission)
  const system = formatSystem(submission)
  const details = [
    detailRow('Account', formatAccount(account)),
    detailRow('Plan', formatPlan(account)),
    detailRow('Submitted', formatUtc(submittedAt)),
    app ? detailRow('App', app) : '',
    system ? detailRow('System', system) : '',
    detailRow(
      'Logs',
      logs ? `Attached: ${logs.filename} (${formatSize(logs.bytes)})` : 'Not attached'
    )
  ].join('')

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
  <p style="margin:0;color:#18181b;font-size:15px;line-height:1.6;white-space:pre-wrap">${escapeHtml(submission.message)}</p>
  <hr style="border:none;border-top:1px solid #e4e4e7;margin:20px 0 12px">
  <table cellpadding="0" cellspacing="0">${details}</table>
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

// A submission with logs is up to half a megabyte of email, so it gets a
// tighter bucket of its own on top of the route's.
const logsRateLimiter = createRateLimiter({
  maxRequests: 5,
  windowSeconds: 3600,
  keyPrefix: 'feedback-logs'
})

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

  const submission = parsed.data
  if (submission.logs) await logsRateLimiter(c, async () => {})

  const account = await resolveAccount(c)
  const submittedAt = new Date()
  const logs = submission.logs ? logsAttachment(submission.logs, submittedAt) : null
  const replyTo = submission.email ?? account?.email ?? undefined
  const subject = `MemryNote feedback from ${replyTo ?? 'anonymous'}`
  const html = buildFeedbackHtml({ from: replyTo, submission, account, submittedAt, logs })
  const attachments = logs ? [{ filename: logs.filename, content: logs.content }] : undefined

  await sendEmail(recipient, subject, html, c.env.RESEND_API_KEY, replyTo, c.env, attachments)

  return c.json({ success: true }, 202)
})
