import type { VercelRequest, VercelResponse } from '@vercel/node'

const RESEND_API_BASE_URL = 'https://api.resend.com'

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

/**
 * Newsletter signup — creates the Resend contact, then files it into the configured
 * segment. Both calls treat "already exists" as success, so re-submitting an address
 * is idempotent rather than an error the visitor has to read.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY
  const RESEND_SEGMENT_ID = process.env.RESEND_SEGMENT_ID?.trim()

  if (!RESEND_API_KEY) {
    console.error('[subscribe] RESEND_API_KEY is not configured')
    return res.status(500).json({ error: 'Server configuration error' })
  }

  if (!RESEND_SEGMENT_ID) {
    console.error('[subscribe] RESEND_SEGMENT_ID is not configured')
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
      console.error('[subscribe] Resend API error:', sanitizeLogValue(contactError))
      return res.status(contactRes.status).json({ error: contactError })
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
