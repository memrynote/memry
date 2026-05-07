import type { VercelRequest, VercelResponse } from '@vercel/node'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY
  const RESEND_SEGMENT_ID = process.env.RESEND_SEGMENT_ID

  console.log(
    '[waitlist] RESEND_API_KEY:',
    RESEND_API_KEY ? `${RESEND_API_KEY.slice(0, 6)}...` : 'MISSING'
  )
  console.log('[waitlist] RESEND_SEGMENT_ID:', RESEND_SEGMENT_ID || 'not set')

  if (!RESEND_API_KEY) {
    console.error('[waitlist] RESEND_API_KEY is not configured')
    return res.status(500).json({ error: 'Server configuration error' })
  }

  const { email } = req.body

  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Email is required' })
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(email)) {
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
      console.error('Resend API error:', contactData)
      return res.status(contactRes.status).json({
        error: contactData.message || 'Failed to add contact'
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
    console.error('Waitlist error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
}
