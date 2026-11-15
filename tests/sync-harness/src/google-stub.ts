import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { Response, fetch, type Request } from 'miniflare'

/**
 * Google's two endpoints the Worker calls during a browser sign-in
 * (`apps/sync-server/src/routes/auth.ts` `POST /oauth/:provider/callback`): the code exchange at
 * `oauth2.googleapis.com/token` and the ID-token keys at `www.googleapis.com/oauth2/v3/certs`.
 *
 * A code `harness-google:<email>` exchanges for an ID token for `<email>`, signed with a key the
 * certs endpoint publishes, so the Worker's real verification runs. Any other code is refused as
 * Google refuses a spent one. Every other request leaves for the network as before.
 */
export const GOOGLE_CLIENT_ID = 'harness-google-client'
export const GOOGLE_CLIENT_SECRET = 'harness-google-secret'
const CODE_PREFIX = 'harness-google:'
const KEY_ID = 'harness-google-key'

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export async function createGoogleStub(): Promise<(request: Request) => Promise<Response>> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
  const jwk = { ...(await exportJWK(publicKey)), kid: KEY_ID, alg: 'RS256', use: 'sig' }

  return async (request) => {
    const url = new URL(request.url)
    if (url.host === 'www.googleapis.com' && url.pathname === '/oauth2/v3/certs') {
      return json({ keys: [jwk] })
    }
    if (url.host === 'oauth2.googleapis.com' && url.pathname === '/token') {
      const form = new URLSearchParams(await request.text())
      const code = form.get('code') ?? ''
      if (!code.startsWith(CODE_PREFIX) || form.get('client_id') !== GOOGLE_CLIENT_ID) {
        return json({ error: 'invalid_grant' }, 400)
      }
      const email = code.slice(CODE_PREFIX.length)
      const idToken = await new SignJWT({ email, email_verified: true })
        .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
        .setIssuer('https://accounts.google.com')
        .setAudience(GOOGLE_CLIENT_ID)
        .setSubject(`google-${email}`)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey)
      return json({ id_token: idToken })
    }
    return fetch(request)
  }
}
