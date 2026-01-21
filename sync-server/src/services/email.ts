/**
 * T034: Resend Email Service
 *
 * Provides email delivery using Resend for OTP codes and notifications.
 */

import { Resend } from 'resend'

/**
 * Email service configuration.
 */
export interface EmailConfig {
  apiKey: string
  fromEmail: string
  fromName: string
}

/**
 * Email send result.
 */
export interface EmailResult {
  success: boolean
  messageId?: string
  error?: string
}

/**
 * Create an email service instance.
 *
 * @param config - Email service configuration
 * @returns Email service with methods for sending various email types
 */
export const createEmailService = (config: EmailConfig) => {
  const resend = new Resend(config.apiKey)
  const from = `${config.fromName} <${config.fromEmail}>`

  return {
    /**
     * Send OTP verification code.
     *
     * @param email - Recipient email address
     * @param code - OTP code (6 digits)
     * @returns Send result
     */
    sendOtpCode: async (email: string, code: string): Promise<EmailResult> => {
      try {
        const { data, error } = await resend.emails.send({
          from,
          to: email,
          subject: 'Your Memry verification code',
          html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f5f5f5;">
  <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    <div style="background: #ffffff; border-radius: 12px; padding: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
      <h1 style="margin: 0 0 24px 0; font-size: 24px; font-weight: 600; color: #1a1a1a;">
        Verification Code
      </h1>
      <p style="margin: 0 0 24px 0; font-size: 16px; line-height: 1.5; color: #4a4a4a;">
        Enter this code to verify your device:
      </p>
      <div style="background: #f8f8f8; border-radius: 8px; padding: 24px; text-align: center; margin: 0 0 24px 0;">
        <span style="font-size: 36px; font-weight: 700; letter-spacing: 8px; color: #1a1a1a; font-family: 'SF Mono', Monaco, monospace;">
          ${code}
        </span>
      </div>
      <p style="margin: 0 0 8px 0; font-size: 14px; color: #6a6a6a;">
        This code expires in <strong>10 minutes</strong>.
      </p>
      <p style="margin: 0; font-size: 14px; color: #6a6a6a;">
        If you didn't request this code, you can safely ignore this email.
      </p>
    </div>
    <p style="margin: 24px 0 0 0; text-align: center; font-size: 12px; color: #999;">
      Sent by Memry
    </p>
  </div>
</body>
</html>
          `,
          text: `Your Memry verification code is: ${code}\n\nThis code expires in 10 minutes.\n\nIf you didn't request this code, you can safely ignore this email.`,
        })

        if (error) {
          return { success: false, error: error.message }
        }

        return { success: true, messageId: data?.id }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to send email',
        }
      }
    },

    /**
     * Send device linking notification.
     *
     * @param email - Recipient email address
     * @param deviceName - Name of the linked device
     * @param platform - Platform of the device (macOS, Windows, etc.)
     * @returns Send result
     */
    sendDeviceLinkingAlert: async (
      email: string,
      deviceName: string,
      platform: string
    ): Promise<EmailResult> => {
      try {
        const timestamp = new Date().toLocaleString('en-US', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          timeZoneName: 'short',
        })

        const { data, error } = await resend.emails.send({
          from,
          to: email,
          subject: 'New device linked to your Memry account',
          html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f5f5f5;">
  <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    <div style="background: #ffffff; border-radius: 12px; padding: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
      <h1 style="margin: 0 0 24px 0; font-size: 24px; font-weight: 600; color: #1a1a1a;">
        New Device Linked
      </h1>
      <p style="margin: 0 0 24px 0; font-size: 16px; line-height: 1.5; color: #4a4a4a;">
        A new device has been linked to your Memry account:
      </p>
      <div style="background: #f8f8f8; border-radius: 8px; padding: 20px; margin: 0 0 24px 0;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 8px 0; font-size: 14px; color: #6a6a6a; width: 100px;">Device</td>
            <td style="padding: 8px 0; font-size: 14px; color: #1a1a1a; font-weight: 500;">${deviceName}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; font-size: 14px; color: #6a6a6a;">Platform</td>
            <td style="padding: 8px 0; font-size: 14px; color: #1a1a1a; font-weight: 500;">${platform}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; font-size: 14px; color: #6a6a6a;">Time</td>
            <td style="padding: 8px 0; font-size: 14px; color: #1a1a1a; font-weight: 500;">${timestamp}</td>
          </tr>
        </table>
      </div>
      <p style="margin: 0; font-size: 14px; color: #6a6a6a;">
        If this wasn't you, please remove the device from your account settings immediately.
      </p>
    </div>
    <p style="margin: 24px 0 0 0; text-align: center; font-size: 12px; color: #999;">
      Sent by Memry
    </p>
  </div>
</body>
</html>
          `,
          text: `A new device has been linked to your Memry account:\n\nDevice: ${deviceName}\nPlatform: ${platform}\nTime: ${timestamp}\n\nIf this wasn't you, please remove the device from your account settings immediately.`,
        })

        if (error) {
          return { success: false, error: error.message }
        }

        return { success: true, messageId: data?.id }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to send email',
        }
      }
    },

    /**
     * Send device removal notification.
     *
     * @param email - Recipient email address
     * @param deviceName - Name of the removed device
     * @returns Send result
     */
    sendDeviceRemovedAlert: async (
      email: string,
      deviceName: string
    ): Promise<EmailResult> => {
      try {
        const timestamp = new Date().toLocaleString('en-US', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          timeZoneName: 'short',
        })

        const { data, error } = await resend.emails.send({
          from,
          to: email,
          subject: 'Device removed from your Memry account',
          html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f5f5f5;">
  <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    <div style="background: #ffffff; border-radius: 12px; padding: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
      <h1 style="margin: 0 0 24px 0; font-size: 24px; font-weight: 600; color: #1a1a1a;">
        Device Removed
      </h1>
      <p style="margin: 0 0 24px 0; font-size: 16px; line-height: 1.5; color: #4a4a4a;">
        A device has been removed from your Memry account:
      </p>
      <div style="background: #f8f8f8; border-radius: 8px; padding: 20px; margin: 0 0 24px 0;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 8px 0; font-size: 14px; color: #6a6a6a; width: 100px;">Device</td>
            <td style="padding: 8px 0; font-size: 14px; color: #1a1a1a; font-weight: 500;">${deviceName}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; font-size: 14px; color: #6a6a6a;">Time</td>
            <td style="padding: 8px 0; font-size: 14px; color: #1a1a1a; font-weight: 500;">${timestamp}</td>
          </tr>
        </table>
      </div>
      <p style="margin: 0; font-size: 14px; color: #6a6a6a;">
        If you didn't make this change, please secure your account immediately.
      </p>
    </div>
    <p style="margin: 24px 0 0 0; text-align: center; font-size: 12px; color: #999;">
      Sent by Memry
    </p>
  </div>
</body>
</html>
          `,
          text: `A device has been removed from your Memry account:\n\nDevice: ${deviceName}\nTime: ${timestamp}\n\nIf you didn't make this change, please secure your account immediately.`,
        })

        if (error) {
          return { success: false, error: error.message }
        }

        return { success: true, messageId: data?.id }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to send email',
        }
      }
    },
  }
}

/**
 * Type for the email service instance.
 */
export type EmailService = ReturnType<typeof createEmailService>
