import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { VercelRequest, VercelResponse } from '@vercel/node'

import handler from './subscribe.ts'

interface ResendCall {
  url: string
  body: unknown
}

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }
let calls: ResendCall[] = []

/** Stands in for the Resend API: every contact is created as contact_1. */
function stubResend(): void {
  calls = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
    const payload = url.endsWith('/contacts') ? { id: 'contact_1' } : {}
    return new Response(JSON.stringify(payload), { status: 200 })
  }
}

async function post(body: unknown): Promise<{ status: number; body: unknown }> {
  const result = { status: 0, body: undefined as unknown }
  const res = {
    status(code: number) {
      result.status = code
      return res
    },
    json(payload: unknown) {
      result.body = payload
      return res
    }
  }
  // Test doubles: the handler reads only method and body, and answers through status().json().
  await handler(
    { method: 'POST', body } as unknown as VercelRequest,
    res as unknown as VercelResponse
  )
  return result
}

describe('subscribe', () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = 're_test'
    process.env.RESEND_SEGMENT_ID = 'seg_newsletter'
    stubResend()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    process.env = { ...originalEnv }
  })

  it('files an iPhone beta signup into the iOS beta segment', async () => {
    const result = await post({ email: 'ada@example.com', list: 'ios-beta' })

    assert.deepEqual(result, { status: 200, body: { success: true } })
    assert.deepEqual(calls, [
      { url: 'https://api.resend.com/contacts', body: { email: 'ada@example.com' } },
      {
        url: 'https://api.resend.com/contacts/contact_1/segments/1aa1ee79-0fa4-4e7e-81e6-810b035815e8',
        body: null
      }
    ])
  })

  it('keeps a request without a list on the newsletter segment', async () => {
    const result = await post({ email: 'ada@example.com' })

    assert.deepEqual(result, { status: 200, body: { success: true } })
    assert.equal(calls[1]?.url, 'https://api.resend.com/contacts/contact_1/segments/seg_newsletter')
  })

  it('rejects a list it does not know without calling Resend', async () => {
    const result = await post({ email: 'ada@example.com', list: 'everyone' })

    assert.deepEqual(result, { status: 400, body: { error: 'Unknown list' } })
    assert.deepEqual(calls, [])
  })
})
