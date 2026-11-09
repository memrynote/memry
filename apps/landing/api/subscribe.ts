import type { VercelRequest, VercelResponse } from '@vercel/node'

import {
  addExternalBetaTester,
  readAppStoreConnectConfig,
  verifyTurnstileToken
} from './ios-beta-support.ts'

const RESEND_API_BASE_URL = 'https://api.resend.com'

/** The Resend segment behind /ios-beta. Not a secret: it only works with RESEND_API_KEY. */
const IOS_BETA_SEGMENT_ID = '1aa1ee79-0fa4-4e7e-81e6-810b035815e8'

/** Lists a visitor can join. A request without `list` is the newsletter, as before. */
const LISTS = ['newsletter', 'ios-beta'] as const
type List = (typeof LISTS)[number]

function isList(value: unknown): value is List {
  return LISTS.some((list) => list === value)
}

function segmentIdFor(list: List): string | undefined {
  return list === 'ios-beta' ? IOS_BETA_SEGMENT_ID : process.env.RESEND_SEGMENT_ID?.trim()
}

function hasControlWhitespace(value: string): boolean {
  for (const char of value) {
    if (char <= ' ' || char === '\u007f') {
      return true
    }
  }

  return false
}

function isValidEmail(value: string): boolean {
  if (value.length > 254 || hasControlWhitespace(value)) {
    return false
  }

  const atIndex = value.indexOf('@')
  if (atIndex <= 0 || atIndex !== value.lastIndexOf('@') || atIndex === value.length - 1) {
    return false
  }

  const domain = value.slice(atIndex + 1)
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) {
    return false
  }

  return domain.split('.').every((part) => part.length > 0 && part.length <= 63)
}

function sanitizeLogValue(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value)
  return text.split('\r').join(' ').split('\n').join(' ')
}

function getResendErrorMessage(data: unknown): string {
  if (data && typeof data === 'object' && 'message' in data && typeof data.message === 'string') {
    return data.message
  }

  return 'Failed to add contact'
}

/** Resend answers a repeat signup with 409 — for us that is the same "subscribed" outcome. */
function isAlreadyExistsError(status: number, message: string): boolean {
  return status === 409 && message.toLowerCase().includes('already')
}

function getResendContactId(data: unknown): string | null {
  if (data && typeof data === 'object' && 'id' in data && typeof data.id === 'string') {
    return data.id
  }

  return null
}

export function getResendSegmentContactUrl(contactIdOrEmail: string, segmentId: string): string {
  return `${RESEND_API_BASE_URL}/contacts/${encodeURIComponent(
    contactIdOrEmail
  )}/segments/${encodeURIComponent(segmentId)}`
}

function getRequestBody(req: VercelRequest): unknown {
  if (typeof req.body !== 'string') return req.body

  try {
    return JSON.parse(req.body)
  } catch {
    return null
  }
}

type Failure = { status: number; error: string }

/**
 * The iPhone beta step: a Turnstile check (Apple mails every address we add, so bots must not
 * reach it), then the address joins the external TestFlight group and Apple sends the invite.
 * Re-adding an existing tester succeeds, so a repeat submit stays idempotent.
 */
async function inviteToTestflight(
  req: VercelRequest,
  email: string,
  turnstileToken: unknown
): Promise<Failure | null> {
  const turnstileSecret = process.env.TURNSTILE_SECRET_KEY?.trim()
  const ascConfig = readAppStoreConnectConfig(process.env)
  if (!turnstileSecret || !ascConfig) {
    console.error('[subscribe] TURNSTILE_SECRET_KEY or the ASC_* TestFlight env is not configured')
    return { status: 500, error: 'Server configuration error' }
  }

  if (typeof turnstileToken !== 'string' || !turnstileToken) {
    return { status: 400, error: 'Please complete the verification.' }
  }

  const remoteIp = req.headers['x-real-ip']
  const human = await verifyTurnstileToken({
    secret: turnstileSecret,
    token: turnstileToken,
    remoteIp: typeof remoteIp === 'string' ? remoteIp : undefined
  })
  if (!human) {
    return { status: 400, error: 'Verification failed. Please try again.' }
  }

  const result = await addExternalBetaTester(ascConfig, email)
  if (!result.ok) {
    console.error(
      `[subscribe] App Store Connect beta tester error (${result.status}):`,
      sanitizeLogValue(result.detail)
    )
    return { status: 502, error: 'Could not send the TestFlight invite. Please try again.' }
  }

  return null
}

/**
 * List signup — creates the Resend contact, then files it into the segment of the list it
 * asked for (the newsletter, or the iPhone beta invite list). Both calls treat "already
 * exists" as success, so re-submitting an address is idempotent rather than an error the
 * visitor has to read. An iPhone beta signup first goes through `inviteToTestflight`.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY

  if (!RESEND_API_KEY) {
    console.error('[subscribe] RESEND_API_KEY is not configured')
    return res.status(500).json({ error: 'Server configuration error' })
  }

  const body = getRequestBody(req)
  const fields: { email?: unknown; list?: unknown; turnstileToken?: unknown } =
    body && typeof body === 'object' ? body : {}
  const { email } = fields
  const list = fields.list ?? 'newsletter'

  if (!isList(list)) {
    return res.status(400).json({ error: 'Unknown list' })
  }

  const segmentId = segmentIdFor(list)
  if (!segmentId) {
    console.error(`[subscribe] no Resend segment configured for the ${list} list`)
    return res.status(500).json({ error: 'Server configuration error' })
  }

  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Email is required' })
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Invalid email format' })
  }

  const headers = {
    Authorization: `Bearer ${RESEND_API_KEY}`,
    'Content-Type': 'application/json'
  }

  try {
    if (list === 'ios-beta') {
      const failure = await inviteToTestflight(req, email, fields.turnstileToken)
      if (failure) return res.status(failure.status).json({ error: failure.error })
    }

    const contactRes = await fetch(`${RESEND_API_BASE_URL}/contacts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email })
    })

    const contactData = await contactRes.json()
    const contactError = getResendErrorMessage(contactData)

    if (!contactRes.ok && !isAlreadyExistsError(contactRes.status, contactError)) {
      console.error('[subscribe] Resend API error:', sanitizeLogValue(contactError))
      return res.status(contactRes.status).json({ error: contactError })
    }

    const contactId = getResendContactId(contactData)
    const segmentContact = contactId ?? email

    const segmentRes = await fetch(getResendSegmentContactUrl(segmentContact, segmentId), {
      method: 'POST',
      headers
    })

    if (!segmentRes.ok) {
      const segmentData = await segmentRes.json()
      const segmentError = getResendErrorMessage(segmentData)

      if (!isAlreadyExistsError(segmentRes.status, segmentError)) {
        console.error('[subscribe] Resend segment API error:', sanitizeLogValue(segmentError))
        return res.status(segmentRes.status).json({ error: segmentError })
      }
    }

    return res.status(200).json({ success: true })
  } catch (error) {
    console.error('[subscribe] request failed:', sanitizeLogValue(error))
    return res.status(500).json({ error: 'Internal server error' })
  }
}
