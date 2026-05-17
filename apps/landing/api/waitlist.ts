import type { VercelRequest, VercelResponse } from '@vercel/node'

function hasControlWhitespace(value: string): boolean {
  for (const char of value) {
    if (char <= ' ' || char === '\u007f') {
      return true
    }
  }

  return false
}

function isValidEmail(email: string): boolean {
  if (email.length > 254 || hasControlWhitespace(email)) {
    return false
  }

  const atIndex = email.indexOf('@')
  if (atIndex <= 0 || atIndex !== email.lastIndexOf('@') || atIndex === email.length - 1) {
    return false
  }

  const domain = email.slice(atIndex + 1)
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY
  const RESEND_SEGMENT_ID = process.env.RESEND_SEGMENT_ID

  if (!RESEND_API_KEY) {
    console.error('[waitlist] RESEND_API_KEY is not configured')
    return res.status(500).json({ error: 'Server configuration error' })
  }

  const { email } = req.body

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
    const contactRes = await fetch('https://api.resend.com/contacts', {
      method: 'POST',
      headers,
      body: JSON.stringify({ email })
    })

    const contactData = await contactRes.json()

    if (!contactRes.ok) {
      console.error(
        '[waitlist] Resend API error:',
        sanitizeLogValue(getResendErrorMessage(contactData))
      )
      return res.status(contactRes.status).json({
        error: getResendErrorMessage(contactData)
      })
    }

    if (RESEND_SEGMENT_ID && contactData.id) {
      await fetch(`https://api.resend.com/segments/${RESEND_SEGMENT_ID}/contacts`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ contact_ids: [contactData.id] })
      })
    }

    return res.status(200).json({
      success: true,
      id: contactData.id
    })
  } catch (error) {
    console.error('[waitlist] request failed:', sanitizeLogValue(error))
    return res.status(500).json({ error: 'Internal server error' })
  }
}
