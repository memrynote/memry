/**
 * Email Service
 *
 * Sends transactional emails using Resend API.
 * Handles email verification, password reset, and notifications.
 *
 * @module services/email
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Email send result
 */
export interface EmailResult {
  success: boolean
  messageId?: string
  error?: string
}

/**
 * Email template data
 */
export interface EmailTemplateData {
  [key: string]: string | number | boolean | undefined
}

// =============================================================================
// Configuration
// =============================================================================

/**
 * Default sender email (Resend's test email - no verification needed)
 * Override via EMAIL_FROM env var in production
 */
const DEFAULT_FROM_EMAIL = 'Memry <onboarding@resend.dev>'

/**
 * Base URL for verification/reset links
 * Uses memry:// custom protocol for Electron app deep linking
 */
const DEFAULT_APP_BASE_URL = 'memry://auth'

// =============================================================================
// Email Sending
// =============================================================================

/**
 * Send an email using Resend API.
 *
 * @param to - Recipient email address
 * @param subject - Email subject
 * @param html - HTML email body
 * @param apiKey - Resend API key
 * @returns Send result
 */
export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  apiKey: string
): Promise<EmailResult> {
  if (!apiKey) {
    console.error('RESEND_API_KEY not configured')
    return { success: false, error: 'Email service not configured' }
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: DEFAULT_FROM_EMAIL,
        to: [to],
        subject,
        html,
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      console.error('Resend API error:', error)
      return { success: false, error: `Email send failed: ${response.status}` }
    }

    const result = (await response.json()) as { id: string }

    return {
      success: true,
      messageId: result.id,
    }
  } catch (error) {
    console.error('Email send error:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

// =============================================================================
// Email Templates
// =============================================================================

/**
 * Email verification template.
 */
function verificationEmailTemplate(token: string): { subject: string; html: string } {
  const verifyUrl = `${DEFAULT_APP_BASE_URL}/verify-email?token=${encodeURIComponent(token)}`

  return {
    subject: 'Verify your Memry account',
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verify your email</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 28px;">Welcome to Memry</h1>
  </div>

  <div style="background: #f9fafb; padding: 30px; border-radius: 0 0 10px 10px;">
    <p style="margin-top: 0;">Thanks for signing up! Please verify your email address to get started.</p>

    <div style="text-align: center; margin: 30px 0;">
      <a href="${verifyUrl}" style="background: #667eea; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: 500; display: inline-block;">
        Verify Email Address
      </a>
    </div>

    <p style="font-size: 14px; color: #666;">
      If the button doesn't work, copy and paste this link into your browser:
      <br>
      <a href="${verifyUrl}" style="color: #667eea; word-break: break-all;">${verifyUrl}</a>
    </p>

    <p style="font-size: 14px; color: #666; margin-bottom: 0;">
      This link expires in 24 hours. If you didn't create an account, you can safely ignore this email.
    </p>
  </div>

  <div style="text-align: center; padding: 20px; color: #999; font-size: 12px;">
    <p>Memry - Your personal knowledge base</p>
  </div>
</body>
</html>
    `.trim(),
  }
}

/**
 * Password reset template.
 */
function passwordResetEmailTemplate(token: string): { subject: string; html: string } {
  const resetUrl = `${DEFAULT_APP_BASE_URL}/reset-password?token=${encodeURIComponent(token)}`

  return {
    subject: 'Reset your Memry password',
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset your password</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 28px;">Password Reset</h1>
  </div>

  <div style="background: #f9fafb; padding: 30px; border-radius: 0 0 10px 10px;">
    <p style="margin-top: 0;">We received a request to reset your Memry password. Click the button below to choose a new password.</p>

    <div style="text-align: center; margin: 30px 0;">
      <a href="${resetUrl}" style="background: #667eea; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: 500; display: inline-block;">
        Reset Password
      </a>
    </div>

    <p style="font-size: 14px; color: #666;">
      If the button doesn't work, copy and paste this link into your browser:
      <br>
      <a href="${resetUrl}" style="color: #667eea; word-break: break-all;">${resetUrl}</a>
    </p>

    <p style="font-size: 14px; color: #666; margin-bottom: 0;">
      This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.
    </p>
  </div>

  <div style="text-align: center; padding: 20px; color: #999; font-size: 12px;">
    <p>Memry - Your personal knowledge base</p>
  </div>
</body>
</html>
    `.trim(),
  }
}

/**
 * New device linked notification template.
 */
function deviceLinkedEmailTemplate(deviceName: string, devicePlatform: string): { subject: string; html: string } {
  return {
    subject: 'New device linked to your Memry account',
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New device linked</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 28px;">New Device Linked</h1>
  </div>

  <div style="background: #f9fafb; padding: 30px; border-radius: 0 0 10px 10px;">
    <p style="margin-top: 0;">A new device has been linked to your Memry account:</p>

    <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e5e7eb;">
      <p style="margin: 0 0 10px 0;"><strong>Device:</strong> ${deviceName}</p>
      <p style="margin: 0;"><strong>Platform:</strong> ${devicePlatform}</p>
    </div>

    <p style="font-size: 14px; color: #666; margin-bottom: 0;">
      If you didn't link this device, please remove it from your account settings immediately and change your password.
    </p>
  </div>

  <div style="text-align: center; padding: 20px; color: #999; font-size: 12px;">
    <p>Memry - Your personal knowledge base</p>
  </div>
</body>
</html>
    `.trim(),
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Send email verification email.
 *
 * @param to - Recipient email
 * @param token - Verification token
 * @param apiKey - Resend API key
 */
export async function sendVerificationEmail(to: string, token: string, apiKey: string): Promise<EmailResult> {
  const { subject, html } = verificationEmailTemplate(token)
  return sendEmail(to, subject, html, apiKey)
}

/**
 * Send password reset email.
 *
 * @param to - Recipient email
 * @param token - Reset token
 * @param apiKey - Resend API key
 */
export async function sendPasswordResetEmail(to: string, token: string, apiKey: string): Promise<EmailResult> {
  const { subject, html } = passwordResetEmailTemplate(token)
  return sendEmail(to, subject, html, apiKey)
}

/**
 * Send device linked notification email.
 *
 * @param to - Recipient email
 * @param deviceName - Name of linked device
 * @param devicePlatform - Platform of linked device
 * @param apiKey - Resend API key
 */
export async function sendDeviceLinkedEmail(
  to: string,
  deviceName: string,
  devicePlatform: string,
  apiKey: string
): Promise<EmailResult> {
  const { subject, html } = deviceLinkedEmailTemplate(deviceName, devicePlatform)
  return sendEmail(to, subject, html, apiKey)
}
