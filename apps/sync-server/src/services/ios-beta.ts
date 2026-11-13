import { importPKCS8, SignJWT } from 'jose'

const ASC_API_BASE_URL = 'https://api.appstoreconnect.apple.com'
const RESEND_API_BASE_URL = 'https://api.resend.com'

/** Apple rejects tokens that live longer than 20 minutes; one request needs far less. */
const ASC_TOKEN_LIFETIME_SECONDS = 300

/**
 * The Resend "iOS beta" segment, the same one the landing /ios-beta form fills
 * (`apps/landing/api/subscribe.ts`). Not a secret: it only works with RESEND_API_KEY.
 */
export const IOS_BETA_SEGMENT_ID = '1aa1ee79-0fa4-4e7e-81e6-810b035815e8'

export interface AppStoreConnectEnv {
  ASC_KEY_ID?: string
  ASC_ISSUER_ID?: string
  ASC_PRIVATE_KEY?: string
  ASC_BETA_GROUP_ID?: string
}

export interface AppStoreConnectConfig {
  keyId: string
  issuerId: string
  privateKey: string
  betaGroupId: string
}

export const readAppStoreConnectConfig = (
  env: AppStoreConnectEnv
): AppStoreConnectConfig | null => {
  const keyId = env.ASC_KEY_ID?.trim()
  const issuerId = env.ASC_ISSUER_ID?.trim()
  // Secret stores often keep a .p8 on one line with literal "\n" escapes.
  const privateKey = env.ASC_PRIVATE_KEY?.trim().replaceAll('\\n', '\n')
  const betaGroupId = env.ASC_BETA_GROUP_ID?.trim()
  if (!keyId || !issuerId || !privateKey || !betaGroupId) return null
  return { keyId, issuerId, privateKey, betaGroupId }
}

/** ES256 JWT for the App Store Connect API, signed with the team API key (.p8). */
export const createAppStoreConnectToken = async (
  config: AppStoreConnectConfig,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<string> => {
  const key = await importPKCS8(config.privateKey, 'ES256')
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: config.keyId, typ: 'JWT' })
    .setIssuer(config.issuerId)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + ASC_TOKEN_LIFETIME_SECONDS)
    .setAudience('appstoreconnect-v1')
    .sign(key)
}

export type ExternalCallResult = { ok: true } | { ok: false; status: number; detail: string }

const describeAscErrors = (data: unknown): string => {
  if (!data || typeof data !== 'object' || !('errors' in data) || !Array.isArray(data.errors)) {
    return ''
  }
  return data.errors
    .map((error: unknown) => {
      const fields: { code?: unknown; detail?: unknown } =
        error && typeof error === 'object' ? error : {}
      const code = typeof fields.code === 'string' ? fields.code : ''
      const detail = typeof fields.detail === 'string' ? fields.detail : ''
      return `${code}: ${detail}`
    })
    .join('; ')
}

/**
 * Adds the address to the external TestFlight group, the same as adding a tester by hand in
 * App Store Connect. Apple sends the invite email itself. Re-adding an existing tester
 * succeeds, so a repeat request stays idempotent.
 */
export const addExternalBetaTester = async (
  config: AppStoreConnectConfig,
  email: string
): Promise<ExternalCallResult> => {
  const response = await fetch(`${ASC_API_BASE_URL}/v1/betaTesters`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await createAppStoreConnectToken(config)}`,
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

  const detail = describeAscErrors(await response.json().catch(() => null))
  return { ok: false, status: response.status, detail: detail || response.statusText }
}

const resendMessage = async (response: Response): Promise<string> => {
  const data: unknown = await response.json().catch(() => null)
  if (data && typeof data === 'object' && 'message' in data && typeof data.message === 'string') {
    return data.message
  }
  return response.statusText
}

/** Resend answers a repeat signup with 409; for us that is the same outcome. */
const isAlreadyExists = (status: number, message: string): boolean =>
  status === 409 && message.toLowerCase().includes('already')

/**
 * Creates (or reuses) the Resend contact and files it into the iOS beta segment, the same
 * two calls the landing form makes.
 */
export const addToIosBetaSegment = async (
  apiKey: string,
  email: string
): Promise<ExternalCallResult> => {
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }

  const contact = await fetch(`${RESEND_API_BASE_URL}/contacts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email })
  })
  if (!contact.ok) {
    const message = await resendMessage(contact)
    if (!isAlreadyExists(contact.status, message)) {
      return { ok: false, status: contact.status, detail: message }
    }
  }

  const segment = await fetch(
    `${RESEND_API_BASE_URL}/contacts/${encodeURIComponent(email)}/segments/${IOS_BETA_SEGMENT_ID}`,
    { method: 'POST', headers }
  )
  if (!segment.ok) {
    const message = await resendMessage(segment)
    if (!isAlreadyExists(segment.status, message)) {
      return { ok: false, status: segment.status, detail: message }
    }
  }
  return { ok: true }
}

/**
 * Tags the contact as a desktop signup and links it to the install's opaque hash, so an
 * email can be traced to its PostHog person without PostHog ever holding the email.
 * Resend only accepts properties that exist in the account (`signup_source`,
 * `install_hash`), so a missing definition fails here without touching the signup.
 */
export const tagIosBetaContact = async (
  apiKey: string,
  email: string,
  properties: Record<string, string>
): Promise<ExternalCallResult> => {
  const response = await fetch(`${RESEND_API_BASE_URL}/contacts/${encodeURIComponent(email)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ properties })
  })
  if (response.ok) return { ok: true }
  return { ok: false, status: response.status, detail: await resendMessage(response) }
}
