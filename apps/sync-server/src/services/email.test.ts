import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ErrorCodes } from '../lib/errors'
import { sendEmail } from './email'

describe('email service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('resolves when Resend API call succeeds', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(sendEmail('user@example.com', 'Hello', '<p>Hi</p>', 'api-key')).resolves.toBe(
      undefined
    )

    expect(fetchMock).toHaveBeenCalledWith('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer api-key',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'MemryNote <noreply@memrynote.com>',
        to: 'user@example.com',
        subject: 'Hello',
        html: '<p>Hi</p>'
      })
    })
  })

  it('throws for non-OK API response', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => 'server error'
    }))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      sendEmail('user@example.com', 'Hello', '<p>Hi</p>', 'api-key')
    ).rejects.toMatchObject({
      code: ErrorCodes.INTERNAL_ERROR,
      statusCode: 500
    })
    expect(errorSpy).toHaveBeenCalledWith(
      JSON.stringify({
        level: 'error',
        scope: 'Email',
        message: 'Resend API error',
        status: 500,
        body: 'server error'
      })
    )
  })

  it('throws on network failures', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down')
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      sendEmail('user@example.com', 'Hello', '<p>Hi</p>', 'api-key')
    ).rejects.toMatchObject({
      code: ErrorCodes.INTERNAL_ERROR,
      statusCode: 500
    })
    expect(errorSpy).toHaveBeenCalledWith(
      JSON.stringify({
        level: 'error',
        scope: 'Email',
        message: 'Failed to send email',
        error: 'network down'
      })
    )
  })

  describe('capture to PostHog', () => {
    const analyticsEnv = {
      ENVIRONMENT: 'test',
      POSTHOG_KEY: 'phc_test',
      POSTHOG_HOST: 'https://us.i.posthog.com',
      TELEMETRY_HMAC_KEY: 'test-hmac-key'
    }

    const findLogCall = (fetchMock: ReturnType<typeof vi.fn>) =>
      fetchMock.mock.calls.find(([url]) => String(url).endsWith('/v1/logs'))

    it('captures Resend API failures when env is provided', async () => {
      const fetchMock = vi.fn(async (url: unknown) => {
        if (String(url).includes('api.resend.com')) {
          return { ok: false, status: 401, text: async (): Promise<string> => 'invalid api key' }
        }
        return new Response('{}', { status: 200 })
      })
      vi.spyOn(console, 'error').mockImplementation(() => undefined)
      vi.stubGlobal('fetch', fetchMock)

      await expect(
        sendEmail('user@example.com', 'Hello', '<p>Hi</p>', 'api-key', undefined, analyticsEnv)
      ).rejects.toMatchObject({ code: ErrorCodes.INTERNAL_ERROR })

      const logCall = findLogCall(fetchMock)
      expect(logCall).toBeDefined()
      const body = JSON.parse((logCall![1] as { body: string }).body)
      // Previously pinned via the Loki stream label `env`; PostHog Logs carries
      // it as a resource attribute instead.
      expect(body.resourceLogs[0].resource.attributes).toContainEqual({
        key: 'deployment.environment',
        value: { stringValue: 'test' }
      })
      const record = body.resourceLogs[0].scopeLogs[0].logRecords[0]
      expect(record.severityText).toBe('error')
      expect(record.attributes).toContainEqual({ key: 'kind', value: { stringValue: 'error' } })
      const line = JSON.parse(record.body.stringValue)
      expect(line.source).toBe('email')
      expect(line.action).toBe('resend_send')
      expect(line.error_code).toBe('RESEND_SEND_FAILED')
    })

    it('captures network failures when env is provided', async () => {
      const fetchMock = vi.fn(async (url: unknown) => {
        if (String(url).includes('api.resend.com')) {
          throw new Error('network down')
        }
        return new Response('{}', { status: 200 })
      })
      vi.spyOn(console, 'error').mockImplementation(() => undefined)
      vi.stubGlobal('fetch', fetchMock)

      await expect(
        sendEmail('user@example.com', 'Hello', '<p>Hi</p>', 'api-key', undefined, analyticsEnv)
      ).rejects.toMatchObject({ code: ErrorCodes.INTERNAL_ERROR })

      const logCall = findLogCall(fetchMock)
      expect(logCall).toBeDefined()
      const line = JSON.parse(
        JSON.parse((logCall![1] as { body: string }).body).resourceLogs[0].scopeLogs[0]
          .logRecords[0].body.stringValue
      )
      expect(line.action).toBe('resend_send')
      expect(line.message).toContain('network down')
    })

    it('does not push to PostHog without env', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => 'server error'
      }))
      vi.spyOn(console, 'error').mockImplementation(() => undefined)
      vi.stubGlobal('fetch', fetchMock)

      await expect(
        sendEmail('user@example.com', 'Hello', '<p>Hi</p>', 'api-key')
      ).rejects.toMatchObject({ code: ErrorCodes.INTERNAL_ERROR })

      expect(findLogCall(fetchMock)).toBeUndefined()
    })
  })
})
