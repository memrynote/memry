import { createPrivateKey, sign } from 'node:crypto'

const ASC_API_BASE_URL = 'https://api.appstoreconnect.apple.com'
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/** Apple rejects tokens that live longer than 20 minutes; one request needs far less. */
const ASC_TOKEN_LIFETIME_SECONDS = 300

export interface AppStoreConnectConfig {
  keyId: string
  issuerId: string
  privateKey: string
  betaGroupId: string
}

export function readAppStoreConnectConfig(env: NodeJS.ProcessEnv): AppStoreConnectConfig | null {
  const keyId = env.ASC_KEY_ID?.trim()
  const issuerId = env.ASC_ISSUER_ID?.trim()
  const privateKey = env.ASC_PRIVATE_KEY?.trim()
  const betaGroupId = env.ASC_BETA_GROUP_ID?.trim()
  if (!keyId || !issuerId || !privateKey || !betaGroupId) return null
  return { keyId, issuerId, privateKey, betaGroupId }
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

/** ES256 JWT for the App Store Connect API, signed with the team API key (.p8). */
export function createAppStoreConnectToken(
  config: AppStoreConnectConfig,
  nowSeconds = Math.floor(Date.now() / 1000)
): string {
  const header = base64UrlJson({ alg: 'ES256', kid: config.keyId, typ: 'JWT' })
  const payload = base64UrlJson({
    iss: config.issuerId,
    iat: nowSeconds,
    exp: nowSeconds + ASC_TOKEN_LIFETIME_SECONDS,
    aud: 'appstoreconnect-v1'
  })
  const signingInput = `${header}.${payload}`
  const signature = sign('sha256', Buffer.from(signingInput), {
    key: createPrivateKey(config.privateKey),
    dsaEncoding: 'ieee-p1363'
  })
  return `${signingInput}.${signature.toString('base64url')}`
}

export type BetaTesterResult = { ok: true } | { ok: false; status: number; detail: string }

function getAppStoreConnectErrors(data: unknown): { code: string; detail: string }[] {
  if (!data || typeof data !== 'object' || !('errors' in data) || !Array.isArray(data.errors)) {
    return []
  }
  return data.errors.map((error: unknown) => {
    const fields: { code?: unknown; detail?: unknown } =
      error && typeof error === 'object' ? error : {}
    return {
      code: typeof fields.code === 'string' ? fields.code : '',
      detail: typeof fields.detail === 'string' ? fields.detail : ''
    }
  })
}

/**
 * Adds the address to the external TestFlight group, the same as adding a tester by hand in
 * App Store Connect. Apple sends the invite email itself once the group has a build that
 * passed Beta App Review.
 */
export async function addExternalBetaTester(
  config: AppStoreConnectConfig,
  email: string
): Promise<BetaTesterResult> {
  const response = await fetch(`${ASC_API_BASE_URL}/v1/betaTesters`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${createAppStoreConnectToken(config)}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      data: {
        type: 'betaTesters',
        attributes: { email },
        relationships: {
          betaGroups: { data: [{ type: 'betaGroups', id: config.betaGroupId }] }
        }
      }
    })
  })
  if (response.ok) return { ok: true }

  const errors = getAppStoreConnectErrors(await response.json().catch(() => null))
  const detail = errors.map((error) => `${error.code}: ${error.detail}`).join('; ')
  return { ok: false, status: response.status, detail: detail || response.statusText }
}

/** Server-side check of the Cloudflare Turnstile token the /ios-beta form sends. */
export async function verifyTurnstileToken(input: {
  secret: string
  token: string
  remoteIp?: string
}): Promise<boolean> {
  const form = new URLSearchParams({ secret: input.secret, response: input.token })
  if (input.remoteIp) form.set('remoteip', input.remoteIp)

  const response = await fetch(TURNSTILE_VERIFY_URL, { method: 'POST', body: form })
  const data: unknown = await response.json().catch(() => null)
  return Boolean(data && typeof data === 'object' && 'success' in data && data.success === true)
}
