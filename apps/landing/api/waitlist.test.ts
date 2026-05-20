import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import handler, { getResendSegmentContactUrl, normalizeWaitlistAttribution } from './waitlist.ts'

function createMockResponse() {
  let statusCode = 200
  let body: unknown

  return {
    response: {
      status(code: number) {
        statusCode = code
        return this
      },
      json(payload: unknown) {
        body = payload
        return this
      }
    },
    get statusCode() {
      return statusCode
    },
    get body() {
      return body
    }
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function withWaitlistEnv(test: () => Promise<void>): Promise<void> {
  const previousEnv = {
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    RESEND_SEGMENT_ID: process.env.RESEND_SEGMENT_ID,
    POSTHOG_API_KEY: process.env.POSTHOG_API_KEY,
    POSTHOG_HOST: process.env.POSTHOG_HOST
  }

  process.env.RESEND_API_KEY = 'test-resend-key'
  process.env.RESEND_SEGMENT_ID = 'memrywaitlsit'
  delete process.env.POSTHOG_API_KEY
  delete process.env.POSTHOG_HOST

  return test().finally(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })
}

describe('waitlist attribution', () => {
  it('keeps only safe campaign fields for server-side signup capture', () => {
    assert.deepEqual(
      normalizeWaitlistAttribution({
        utm_source: 'waitlist',
        utm_medium: 'email',
        utm_campaign: 'waitlist_01_launch_plain',
        utm_content: 'primary_cta',
        email: 'private@example.com',
        token: 'secret'
      }),
      {
        utm_source: 'waitlist',
        utm_medium: 'email',
        utm_campaign: 'waitlist_01_launch_plain',
        utm_content: 'primary_cta'
      }
    )
  })
})

describe('waitlist Resend segment sync', () => {
  it('uses the Resend contact-to-segment endpoint', () => {
    assert.equal(
      getResendSegmentContactUrl('person@example.com', 'memrywaitlsit'),
      'https://api.resend.com/contacts/person%40example.com/segments/memrywaitlsit'
    )
  })

  it('adds successful waitlist signups to the configured segment', async () => {
    await withWaitlistEnv(async () => {
      const previousFetch = globalThis.fetch
      const calls: Array<{ url: string; init?: RequestInit }> = []
      globalThis.fetch = async (input, init) => {
        calls.push({ url: String(input), init })

        if (calls.length === 1) {
          return jsonResponse({ id: 'contact_123' })
        }

        return jsonResponse({ id: 'memrywaitlsit' })
      }

      try {
        const result = createMockResponse()

        await handler(
          {
            method: 'POST',
            body: { email: 'person@example.com' },
            headers: {}
          } as never,
          result.response as never
        )

        assert.equal(result.statusCode, 200)
        assert.deepEqual(result.body, { success: true, id: 'contact_123' })
        assert.equal(calls[0]?.url, 'https://api.resend.com/contacts')
        assert.equal(
          calls[1]?.url,
          'https://api.resend.com/contacts/contact_123/segments/memrywaitlsit'
        )
      } finally {
        globalThis.fetch = previousFetch
      }
    })
  })

  it('fails the signup when the configured segment rejects the contact', async () => {
    await withWaitlistEnv(async () => {
      const previousFetch = globalThis.fetch
      globalThis.fetch = async (_input) => {
        if (_input === 'https://api.resend.com/contacts') {
          return jsonResponse({ id: 'contact_123' })
        }

        return jsonResponse({ message: 'Segment not found' }, 404)
      }

      try {
        const result = createMockResponse()

        await handler(
          {
            method: 'POST',
            body: { email: 'person@example.com' },
            headers: {}
          } as never,
          result.response as never
        )

        assert.equal(result.statusCode, 404)
        assert.deepEqual(result.body, { error: 'Segment not found' })
      } finally {
        globalThis.fetch = previousFetch
      }
    })
  })
})
