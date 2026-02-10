import { beforeEach, describe, expect, it, vi } from 'vitest'

import { sendEmail } from './email'

describe('email service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns true when Resend API call succeeds', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(sendEmail('user@example.com', 'Hello', '<p>Hi</p>', 'api-key')).resolves.toBe(true)

    expect(fetchMock).toHaveBeenCalledWith('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer api-key',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Memry <noreply@memry.app>',
        to: 'user@example.com',
        subject: 'Hello',
        html: '<p>Hi</p>'
      })
    })
  })

  it('returns false and logs for non-OK API response', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => 'server error'
    }))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', fetchMock)

    await expect(sendEmail('user@example.com', 'Hello', '<p>Hi</p>', 'api-key')).resolves.toBe(
      false
    )
    expect(errorSpy).toHaveBeenCalledWith('Resend API error: 500 server error')
  })

  it('returns false on network failures', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down')
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', fetchMock)

    await expect(sendEmail('user@example.com', 'Hello', '<p>Hi</p>', 'api-key')).resolves.toBe(
      false
    )
    expect(errorSpy).toHaveBeenCalledWith('Failed to send email:', 'network down')
  })
})
