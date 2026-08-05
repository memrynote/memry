import { describe, expect, it } from 'vitest'

import { signCheckoutToken } from './checkout-token'

// checkout-token.ts is SIGN-ONLY: it mints the bearer token that POST
// /auth/checkout-token (routes/auth.ts:673) hands to the client, which then
// replays it to the landing checkout endpoint. Verification lives in the
// consumer, apps/landing/api/paddle-checkout-config.ts (`verifyCheckoutToken` +
// `parsePaddleCheckoutIntent`) — there is no verifier anywhere in the sync
// server. So the security property this module owns is narrow but total: the
// emitted token must be an unforgeable HMAC-SHA256 over the encoded payload, in
// exactly the wire format the landing verifier expects.
//
// The reference verifier below decodes independently (atob, and
// crypto.subtle.verify rather than the source's crypto.subtle.sign) so it pins
// the format contract instead of restating the implementation. Node's `Buffer`
// and `node:crypto` are deliberately not used: this package typechecks against
// @cloudflare/workers-types only.
//
// Never use a real secret here.
const TEST_SECRET = 'test-checkout-token-secret'
const OTHER_SECRET = 'a-different-test-secret'

interface CheckoutTokenPayload {
  userId: string
  exp: number
}

const encoder = new TextEncoder()

function base64UrlDecode(value: string): Uint8Array | null {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  try {
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    return null
  }
}

/** Only used to build attack inputs, never to verify one. */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function encodePayload(payload: unknown): string {
  return base64UrlEncode(encoder.encode(JSON.stringify(payload)))
}

/**
 * Independent reference verifier mirroring the checks in
 * apps/landing/api/paddle-checkout-config.ts:106-129 — exactly two segments,
 * signature check, then JSON payload decode. Returns null on any failure and
 * never throws.
 */
async function referenceVerify(
  secret: string,
  token: string
): Promise<CheckoutTokenPayload | null> {
  const [encodedPayload, encodedSignature, extra] = token.split('.')
  if (!encodedPayload || !encodedSignature || extra !== undefined) return null

  const signature = base64UrlDecode(encodedSignature)
  if (!signature) return null

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  )
  const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(encodedPayload))
  if (!valid) return null

  const payloadBytes = base64UrlDecode(encodedPayload)
  if (!payloadBytes) return null

  try {
    return JSON.parse(new TextDecoder().decode(payloadBytes)) as CheckoutTokenPayload
  } catch {
    return null
  }
}

/**
 * The consumer's freshness rule, from paddle-checkout-config.ts:153 —
 * `exp <= nowSeconds` is rejected. Reproduced here only to prove the signer
 * itself does not enforce it.
 */
function isFresh(payload: CheckoutTokenPayload, nowSeconds: number): boolean {
  return typeof payload.exp === 'number' && Number.isFinite(payload.exp) && payload.exp > nowSeconds
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

describe('signCheckoutToken', () => {
  it('mints a token that verifies under the signing secret and round-trips the payload', async () => {
    // #given
    const exp = nowSeconds() + 600

    // #when
    const token = await signCheckoutToken(TEST_SECRET, { userId: 'user-1', exp })

    // #then
    const payload = await referenceVerify(TEST_SECRET, token)
    expect(payload).toEqual({ userId: 'user-1', exp })
    expect(isFresh(payload!, nowSeconds())).toBe(true)
  })

  it('emits exactly two unpadded base64url segments', async () => {
    // #given / #when
    const token = await signCheckoutToken(TEST_SECRET, { userId: 'user-1', exp: 1 })

    // #then — the landing verifier rejects anything that is not
    // `payload.signature`, and base64url means no '+', '/' or '=' may survive.
    const segments = token.split('.')
    expect(segments).toHaveLength(2)
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    // HMAC-SHA256 is 32 bytes -> 43 base64url chars unpadded.
    expect(base64UrlDecode(segments[1])).toHaveLength(32)
    expect(segments[1]).toHaveLength(43)
  })

  it('is deterministic for the same secret and payload', async () => {
    // #given / #when
    const payload = { userId: 'user-1', exp: 1_700_000_000 }
    const first = await signCheckoutToken(TEST_SECRET, payload)
    const second = await signCheckoutToken(TEST_SECRET, payload)

    // #then
    expect(first).toBe(second)
  })

  it('rejects a token signed with the wrong secret', async () => {
    // #given
    const token = await signCheckoutToken(OTHER_SECRET, {
      userId: 'attacker',
      exp: nowSeconds() + 600
    })

    // #then — a token minted under any other secret must not verify.
    await expect(referenceVerify(TEST_SECRET, token)).resolves.toBeNull()
    // Sanity: it is a well-formed token, just bound to a different key.
    await expect(referenceVerify(OTHER_SECRET, token)).resolves.not.toBeNull()
  })

  it('rejects a tampered payload segment (user-id substitution)', async () => {
    // #given — a legitimately signed token for user-1...
    const exp = nowSeconds() + 600
    const token = await signCheckoutToken(TEST_SECRET, { userId: 'user-1', exp })
    const [, signature] = token.split('.')

    // #when — ...whose payload is swapped to a victim while keeping the signature.
    const forged = `${encodePayload({ userId: 'victim-user', exp })}.${signature}`

    // #then — this is the entitlement-hijack case; it must not verify.
    expect(forged).not.toBe(token)
    await expect(referenceVerify(TEST_SECRET, forged)).resolves.toBeNull()
  })

  it('rejects an extended-expiry payload carrying a valid signature', async () => {
    // #given
    const token = await signCheckoutToken(TEST_SECRET, { userId: 'user-1', exp: nowSeconds() + 60 })
    const [, signature] = token.split('.')

    // #when — self-service TTL extension attempt.
    const forgedPayload = encodePayload({
      userId: 'user-1',
      exp: nowSeconds() + 60 * 60 * 24 * 365
    })

    // #then
    await expect(referenceVerify(TEST_SECRET, `${forgedPayload}.${signature}`)).resolves.toBeNull()
  })

  it('rejects a tampered signature segment', async () => {
    // #given
    const token = await signCheckoutToken(TEST_SECRET, {
      userId: 'user-1',
      exp: nowSeconds() + 600
    })
    const [payload, signature] = token.split('.')

    // #when — flip one byte of the MAC.
    const bytes = base64UrlDecode(signature)!
    bytes[0] ^= 0xff

    // #then
    await expect(
      referenceVerify(TEST_SECRET, `${payload}.${base64UrlEncode(bytes)}`)
    ).resolves.toBeNull()
  })

  it('rejects a fully forged token built without the secret', async () => {
    // #given / #when — attacker crafts a payload and MACs it under a guess.
    const payload = encodePayload({ userId: 'user-1', exp: nowSeconds() + 600 })
    const guessed = await signCheckoutToken('guessed-secret', {
      userId: 'user-1',
      exp: nowSeconds() + 600
    })
    const forgedSignature = guessed.split('.')[1]

    // #then
    await expect(referenceVerify(TEST_SECRET, `${payload}.${forgedSignature}`)).resolves.toBeNull()
  })

  it('rejects a signature truncated to the wrong length', async () => {
    // #given
    const token = await signCheckoutToken(TEST_SECRET, {
      userId: 'user-1',
      exp: nowSeconds() + 600
    })
    const [payload, signature] = token.split('.')
    const truncated = base64UrlDecode(signature)!.slice(0, 16)

    // #then — must reject cleanly, not throw on the length mismatch (the landing
    // verifier's timingSafeEqual short-circuits on unequal byte lengths).
    await expect(
      referenceVerify(TEST_SECRET, `${payload}.${base64UrlEncode(truncated)}`)
    ).resolves.toBeNull()
  })

  it.each([
    ['empty string', ''],
    ['no separator', 'notatoken'],
    ['separator only', '.'],
    ['empty payload segment', '.c2ln'],
    ['empty signature segment', 'cGF5.'],
    ['three segments', 'cGF5.c2ln.extra'],
    ['jwt-shaped', 'eyJhbGciOiJub25lIn0.eyJ1c2VySWQiOiJ1c2VyLTEifQ.'],
    ['non-base64 garbage', '!!!.???'],
    ['whitespace', '   '],
    ['valid signature over non-JSON payload', 'bm90LWpzb24.c2ln']
  ])('rejects a malformed token cleanly: %s', async (_label, token) => {
    // #then — must resolve null rather than throw; a throw becomes a 500 on the
    // landing route instead of a clean "no checkout intent".
    await expect(referenceVerify(TEST_SECRET, token)).resolves.toBeNull()
  })

  it('signs an already-expired payload without complaint — expiry is consumer-side only', async () => {
    // #given — signCheckoutToken has no clock and no exp validation of its own.
    const expiredAt = nowSeconds() - 60

    // #when
    const token = await signCheckoutToken(TEST_SECRET, { userId: 'user-1', exp: expiredAt })

    // #then — the MAC is valid, so the ONLY thing stopping replay of a stale
    // token is the consumer's `exp <= now` check. Pinned here so a regression on
    // the consumer side cannot be waved off as "the signer handles it".
    const payload = await referenceVerify(TEST_SECRET, token)
    expect(payload).toEqual({ userId: 'user-1', exp: expiredAt })
    expect(isFresh(payload!, nowSeconds())).toBe(false)
  })

  it('refuses to mint a token under an empty secret', async () => {
    // #then — WebCrypto rejects a zero-length HMAC key, so an unset
    // PADDLE_CHECKOUT_TOKEN_SECRET fails loudly at sign time rather than
    // emitting a token anyone could forge. Defence in depth behind the
    // required-secret guard at src/index.ts:141-147.
    await expect(
      signCheckoutToken('', { userId: 'user-1', exp: nowSeconds() + 600 })
    ).rejects.toThrow()
  })

  it('binds the signature to the whole payload, not just the user id', async () => {
    // #given / #when
    const a = await signCheckoutToken(TEST_SECRET, { userId: 'user-1', exp: 1_700_000_000 })
    const b = await signCheckoutToken(TEST_SECRET, { userId: 'user-1', exp: 1_700_000_001 })

    // #then — cross-pollinating segments between two legitimate tokens must fail.
    const [payloadA, sigA] = a.split('.')
    const [payloadB, sigB] = b.split('.')
    expect(sigA).not.toBe(sigB)
    await expect(referenceVerify(TEST_SECRET, `${payloadA}.${sigB}`)).resolves.toBeNull()
    await expect(referenceVerify(TEST_SECRET, `${payloadB}.${sigA}`)).resolves.toBeNull()
  })

  it('survives payloads with characters that need base64url escaping', async () => {
    // #given — raw base64 '+' and '/' must be replaced and padding stripped, or
    // the landing verifier's base64url decode desynchronises.
    const userId = 'user-üß/+?=&'
    const exp = nowSeconds() + 600

    // #when
    const token = await signCheckoutToken(TEST_SECRET, { userId, exp })

    // #then
    expect(token).not.toMatch(/[+/=]/)
    await expect(referenceVerify(TEST_SECRET, token)).resolves.toEqual({ userId, exp })
  })
})
