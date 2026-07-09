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

  describe('capture to Loki', () => {
    const analyticsEnv = {
      PRODUCT_TELEMETRY: { writeDataPoint: vi.fn() } as never,
      TELEMETRY_HMAC_KEY: 'secret',
      ENVIRONMENT: 'test',
      LOKI_URL: 'https://grafana.example.com',
      LOKI_TOKEN: 'tok'
    }

    const findLokiCall = (fetchMock: ReturnType<typeof vi.fn>) =>
      fetchMock.mock.calls.find(([url]) => String(url).includes('grafana.example.com'))

    it('captures Resend API failures when env is provided', async () => {
      const fetchMock = vi.fn(async (url: unknown) => {
        if (String(url).includes('api.resend.com')) {
          return { ok: false, status: 401, text: async (): Promise<string> => 'invalid api key' }
        }
        return new Response(null, { status: 204 })
      })
      vi.spyOn(console, 'error').mockImplementation(() => undefined)
      vi.stubGlobal('fetch', fetchMock)

      await expect(
        sendEmail('user@example.com', 'Hello', '<p>Hi</p>', 'api-key', undefined, analyticsEnv)
      ).rejects.toMatchObject({ code: ErrorCodes.INTERNAL_ERROR })

      const lokiCall = findLokiCall(fetchMock)
      expect(lokiCall).toBeDefined()
      const body = JSON.parse((lokiCall![1] as { body: string }).body)
      expect(body.streams[0].stream).toEqual({ app: 'server', env: 'test', level: 'error' })
      const line = JSON.parse(body.streams[0].values[0][1])
      expect(line.source).toBe('email')
      expect(line.action).toBe('resend_send')
      expect(line.error_code).toBe('RESEND_SEND_FAILED')
    })

    it('captures network failures when env is provided', async () => {
      const fetchMock = vi.fn(async (url: unknown) => {
        if (String(url).includes('api.resend.com')) {
          throw new Error('network down')
        }
        return new Response(null, { status: 204 })
      })
      vi.spyOn(console, 'error').mockImplementation(() => undefined)
      vi.stubGlobal('fetch', fetchMock)

      await expect(
        sendEmail('user@example.com', 'Hello', '<p>Hi</p>', 'api-key', undefined, analyticsEnv)
      ).rejects.toMatchObject({ code: ErrorCodes.INTERNAL_ERROR })

      const lokiCall = findLokiCall(fetchMock)
      expect(lokiCall).toBeDefined()
      const line = JSON.parse(
        JSON.parse((lokiCall![1] as { body: string }).body).streams[0].values[0][1]
      )
      expect(line.action).toBe('resend_send')
      expect(line.message).toContain('network down')
    })

    it('does not push to Loki without env', async () => {
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

      expect(findLokiCall(fetchMock)).toBeUndefined()
    })
  })
})
