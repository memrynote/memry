import { AppError, ErrorCodes } from '../lib/errors'
import { createLogger } from '../lib/logger'

const logger = createLogger('Email')

const RESEND_API_URL = 'https://api.resend.com/emails'
const FROM_ADDRESS = 'Memry <noreply@memrynote.com>'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const sendEmail = async (
  to: string,
  subject: string,
  html: string,
  apiKey: string
): Promise<void> => {
  if (!EMAIL_RE.test(to)) {
    throw new AppError(ErrorCodes.VALIDATION_INVALID_EMAIL, `Invalid email address: ${to}`, 400)
  }

  try {
    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from: FROM_ADDRESS, to, subject, html })
    })

    if (!response.ok) {
      const body = await response.text()
      logger.error('Resend API error', { status: response.status, body })
      throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Failed to send verification email', 500)
    }
  } catch (err) {
    if (err instanceof AppError) throw err
    logger.error('Failed to send email', { error: err instanceof Error ? err.message : String(err) })
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Failed to send verification email', 500)
  }
}
