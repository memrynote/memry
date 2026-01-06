import type { VercelRequest, VercelResponse } from '@vercel/node'

const RESEND_API_KEY = process.env.RESEND_API_KEY

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  if (!RESEND_API_KEY) {
    console.error('RESEND_API_KEY is not configured')
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

  try {
    const response = await fetch('https://api.resend.com/contacts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email })
    })

    const data = await response.json()

    if (!response.ok) {
      console.error('Resend API error:', data)
      return res.status(response.status).json({
        error: data.message || 'Failed to add contact'
      })
    }

    return res.status(200).json({
      success: true,
      id: data.id
    })
  } catch (error) {
    console.error('Waitlist error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
}
