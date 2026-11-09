import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { VercelRequest, VercelResponse } from '@vercel/node'

import handler from './subscribe.ts'

interface ResendCall {
  url: string
  body: unknown
}

interface ExternalCall {
  url: string
  headers: Headers
  body: unknown
}

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }
let calls: ResendCall[] = []
let externalCalls: ExternalCall[] = []
let turnstilePasses = true
let appleStatus = 201

const ascKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const BETA_TESTERS_URL = 'https://api.appstoreconnect.apple.com/v1/betaTesters'

/**
 * Stands in for Resend (every contact is created as contact_1), Cloudflare Turnstile, and the
 * App Store Connect API, none of which run locally.
 */
function stubExternalApis(): void {
  calls = []
  externalCalls = []
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url === TURNSTILE_URL || url === BETA_TESTERS_URL) {
      const body = init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : null
      externalCalls.push({
        url,
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : body
      })
      if (url === TURNSTILE_URL) return Response.json({ success: turnstilePasses })
      return Response.json(appleStatus === 201 ? { data: {} } : { errors: [] }, {
        status: appleStatus
      })
    }
    calls.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null })
    const payload = url.endsWith('/contacts') ? { id: 'contact_1' } : {}
    return new Response(JSON.stringify(payload), { status: 200 })
  }
}

/** Checks the request carries an ES256 JWT Apple can verify with the team key's public half. */
function assertAppleToken(headers: Headers): void {
  const [header, payload, signature] = (headers.get('authorization') ?? '')
    .replace('Bearer ', '')
    .split('.')
  assert.ok(header && payload && signature)
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), {
    alg: 'ES256',
    kid: 'KEY123',
    typ: 'JWT'
  })
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
  assert.equal(claims.iss, 'issuer-1')
  assert.equal(claims.aud, 'appstoreconnect-v1')
  assert.ok(claims.exp - claims.iat <= 20 * 60)
  assert.ok(
    verify(
      'sha256',
      Buffer.from(`${header}.${payload}`),
      { key: ascKeys.publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url')
    )
  )
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
    { method: 'POST', body, headers: { 'x-real-ip': '203.0.113.7' } } as unknown as VercelRequest,
    res as unknown as VercelResponse
  )
  return result
}

describe('subscribe', () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = 're_test'
    process.env.RESEND_SEGMENT_ID = 'seg_newsletter'
    process.env.TURNSTILE_SECRET_KEY = 'turnstile_secret'
    process.env.ASC_KEY_ID = 'KEY123'
    process.env.ASC_ISSUER_ID = 'issuer-1'
    process.env.ASC_BETA_GROUP_ID = 'group-1'
    process.env.ASC_PRIVATE_KEY = ascKeys.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString()
    turnstilePasses = true
    appleStatus = 201
    stubExternalApis()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    process.env = { ...originalEnv }
  })

  it('invites an iPhone beta signup on TestFlight and files it into the iOS beta segment', async () => {
    const result = await post({ email: 'ada@example.com', list: 'ios-beta', turnstileToken: 'tok' })

    assert.deepEqual(result, { status: 200, body: { success: true } })
    assert.deepEqual(externalCalls[0]?.body, {
      secret: 'turnstile_secret',
      response: 'tok',
      remoteip: '203.0.113.7'
    })
    assert.equal(externalCalls[1]?.url, BETA_TESTERS_URL)
    assertAppleToken(externalCalls[1].headers)
    assert.deepEqual(externalCalls[1].body, {
      data: {
        type: 'betaTesters',
        attributes: { email: 'ada@example.com' },
        relationships: { betaGroups: { data: [{ type: 'betaGroups', id: 'group-1' }] } }
      }
    })
    assert.deepEqual(calls, [
      { url: 'https://api.resend.com/contacts', body: { email: 'ada@example.com' } },
      {
        url: 'https://api.resend.com/contacts/contact_1/segments/1aa1ee79-0fa4-4e7e-81e6-810b035815e8',
        body: null
      }
    ])
  })

  it('stops an iPhone beta signup that fails verification before Apple or Resend', async () => {
    const missing = await post({ email: 'ada@example.com', list: 'ios-beta' })
    assert.equal(missing.status, 400)

    turnstilePasses = false
    const failed = await post({ email: 'ada@example.com', list: 'ios-beta', turnstileToken: 'bot' })
    assert.equal(failed.status, 400)

    assert.deepEqual(
      externalCalls.map((call) => call.url),
      [TURNSTILE_URL]
    )
    assert.deepEqual(calls, [])
  })

  it('reports a TestFlight failure instead of telling the visitor they are in', async () => {
    appleStatus = 403
    const result = await post({ email: 'ada@example.com', list: 'ios-beta', turnstileToken: 'tok' })

    assert.equal(result.status, 502)
    assert.deepEqual(calls, [])
  })

  it('keeps a request without a list on the newsletter segment', async () => {
    const result = await post({ email: 'ada@example.com' })

    assert.deepEqual(result, { status: 200, body: { success: true } })
    assert.equal(calls[1]?.url, 'https://api.resend.com/contacts/contact_1/segments/seg_newsletter')
    assert.deepEqual(externalCalls, [])
  })

  it('rejects a list it does not know without calling Resend', async () => {
    const result = await post({ email: 'ada@example.com', list: 'everyone' })

    assert.deepEqual(result, { status: 400, body: { error: 'Unknown list' } })
    assert.deepEqual(calls, [])
  })
})
