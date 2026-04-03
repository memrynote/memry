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
        from: 'Memry <noreply@memrynote.com>',
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
      JSON.stringify({ level: 'error', scope: 'Email', message: 'Resend API error', status: 500, body: 'server error' })
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
      JSON.stringify({ level: 'error', scope: 'Email', message: 'Failed to send email', error: 'network down' })
    )
  })
})
