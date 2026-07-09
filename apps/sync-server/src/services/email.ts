import { AppError, ErrorCodes } from '../lib/errors'
import { createLogger } from '../lib/logger'
import { captureServerError, type AnalyticsEnv } from './analytics'

const logger = createLogger('Email')

const RESEND_API_URL = 'https://api.resend.com/emails'
const FROM_ADDRESS = 'MemryNote <noreply@memrynote.com>'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const captureSendFailure = async (env: AnalyticsEnv | undefined, error: unknown): Promise<void> => {
  if (!env) return
  await captureServerError(env, {
    error,
    source: 'email',
    action: 'resend_send',
    statusCode: 500,
    errorCode: 'RESEND_SEND_FAILED',
    handled: true
  })
}

export const sendEmail = async (
  to: string,
  subject: string,
  html: string,
  apiKey: string,
  replyTo?: string,
  env?: AnalyticsEnv
): Promise<void> => {
  if (!EMAIL_RE.test(to)) {
    throw new AppError(ErrorCodes.VALIDATION_INVALID_EMAIL, `Invalid email address: ${to}`, 400)
  }

  if (apiKey === 'test-resend-key') {
    logger.info('Skipping email delivery for test API key')
    return
  }

  try {
    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to,
        subject,
        html,
        ...(replyTo && EMAIL_RE.test(replyTo) ? { reply_to: replyTo } : {})
      })
    })

    if (!response.ok) {
      const body = await response.text()
      logger.error('Resend API error', { status: response.status, body })
      await captureSendFailure(env, new Error(`Resend API error: ${response.status} ${body}`))
      throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Failed to send verification email', 500)
    }
  } catch (err) {
    if (err instanceof AppError) throw err
    logger.error('Failed to send email', {
      error: err instanceof Error ? err.message : String(err)
    })
    await captureSendFailure(env, err)
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Failed to send verification email', 500)
  }
}
