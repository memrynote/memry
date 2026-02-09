const RESEND_API_URL = 'https://api.resend.com/emails'
const FROM_ADDRESS = 'Memry <noreply@memry.app>'

export const sendEmail = async (
  to: string,
  subject: string,
  html: string,
  apiKey: string
): Promise<boolean> => {
  try {
    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM_ADDRESS, to, subject, html }),
    })

    if (!response.ok) {
      const body = await response.text()
      console.error(`Resend API error: ${response.status} ${body}`)
      return false
    }

    return true
  } catch (err) {
    console.error('Failed to send email:', err instanceof Error ? err.message : err)
    return false
  }
}
