import { PostHog } from 'posthog-node'
import type { VercelRequest, VercelResponse } from '@vercel/node'

const ATTRIBUTION_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term'
] as const
const ATTRIBUTION_VALUE_LIMIT = 120
const RESEND_API_BASE_URL = 'https://api.resend.com'

type WaitlistAttributionKey = (typeof ATTRIBUTION_KEYS)[number]
type WaitlistAttribution = Partial<Record<WaitlistAttributionKey, string>>

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

function getPostHogClient(): PostHog | null {
  const key = process.env.POSTHOG_API_KEY
  const host = process.env.POSTHOG_HOST
  if (!key || !host) return null
  return new PostHog(key, { host })
}

function getHeaderValue(req: VercelRequest, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0]
  return typeof value === 'string' && value ? value : undefined
}

function getRequestBody(req: VercelRequest): unknown {
  if (typeof req.body !== 'string') return req.body

  try {
    return JSON.parse(req.body)
  } catch {
    return null
  }
}

function normalizeAttributionValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined

  const normalized = value.trim()
  if (!normalized || /[\r\n]/.test(normalized)) return undefined

  return normalized.slice(0, ATTRIBUTION_VALUE_LIMIT)
}

export function normalizeWaitlistAttribution(input: unknown): WaitlistAttribution {
  if (!input || typeof input !== 'object') return {}

  const attribution: WaitlistAttribution = {}

  for (const key of ATTRIBUTION_KEYS) {
    const value = normalizeAttributionValue((input as Record<string, unknown>)[key])
    if (value) attribution[key] = value
  }

  return attribution
}

async function captureWaitlistSignup(
  req: VercelRequest,
  contactId: string,
  resendSegmentConfigured: boolean,
  attribution: WaitlistAttribution
): Promise<void> {
  const posthog = getPostHogClient()
  if (!posthog) return

  try {
    const distinctId = getHeaderValue(req, 'x-posthog-distinct-id') ?? contactId
    const sessionId = getHeaderValue(req, 'x-posthog-session-id')

    posthog.capture({
      distinctId,
      event: 'waitlist_signup_success',
      properties: {
        contact_id: contactId,
        resend_segment_configured: resendSegmentConfigured,
        ...(sessionId ? { $session_id: sessionId } : {}),
        ...attribution
      }
    })
    await posthog.shutdown()
  } catch (error) {
    console.error('[waitlist] PostHog capture failed:', sanitizeLogValue(error))
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY
  const RESEND_SEGMENT_ID = process.env.RESEND_SEGMENT_ID?.trim()

  if (!RESEND_API_KEY) {
    console.error('[waitlist] RESEND_API_KEY is not configured')
    return res.status(500).json({ error: 'Server configuration error' })
  }

  if (!RESEND_SEGMENT_ID) {
    console.error('[waitlist] RESEND_SEGMENT_ID is not configured')
    return res.status(500).json({ error: 'Server configuration error' })
  }

  const body = getRequestBody(req)
  const email =
    body && typeof body === 'object' && 'email' in body ? (body as { email?: unknown }).email : null

  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Email is required' })
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Invalid email format' })
  }

  const attribution = normalizeWaitlistAttribution(
    body && typeof body === 'object' && 'attribution' in body
      ? (body as { attribution?: unknown }).attribution
      : null
  )

  const headers = {
    Authorization: `Bearer ${RESEND_API_KEY}`,
    'Content-Type': 'application/json'
  }

  try {
    const contactRes = await fetch(`${RESEND_API_BASE_URL}/contacts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email })
    })

    const contactData = await contactRes.json()
    const contactError = getResendErrorMessage(contactData)

    if (!contactRes.ok && !isAlreadyExistsError(contactRes.status, contactError)) {
      console.error('[waitlist] Resend API error:', sanitizeLogValue(contactError))
      return res.status(contactRes.status).json({
        error: contactError
      })
    }

    if (!contactRes.ok) {
      console.info('[waitlist] Resend contact already exists; adding it to segment')
    }

    const contactId = getResendContactId(contactData)
    const segmentContact = contactId ?? email

    const segmentRes = await fetch(getResendSegmentContactUrl(segmentContact, RESEND_SEGMENT_ID), {
      method: 'POST',
      headers
    })

    if (!segmentRes.ok) {
      const segmentData = await segmentRes.json()
      const segmentError = getResendErrorMessage(segmentData)

      if (!isAlreadyExistsError(segmentRes.status, segmentError)) {
        console.error('[waitlist] Resend segment API error:', sanitizeLogValue(segmentError))
        return res.status(segmentRes.status).json({
          error: segmentError
        })
      }
    }

    if (contactId) await captureWaitlistSignup(req, contactId, true, attribution)

    return res.status(200).json({
      success: true,
      id: contactId
    })
  } catch (error) {
    console.error('[waitlist] request failed:', sanitizeLogValue(error))
    return res.status(500).json({ error: 'Internal server error' })
  }
}
