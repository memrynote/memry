import { isIP } from 'node:net'
import { digestAuthorization, parseDigestChallenge, type DigestChallenge } from './caldav-digest'

/**
 * The one HTTP path every CalDAV request takes (#1399). It owns three things
 * `fetch` gets wrong for CalDAV:
 *
 * 1. **Credentials across redirects.** iCloud answers discovery with a
 *    redirect to a per-account partition host (`p67-caldav.icloud.com`).
 *    `fetch` drops `Authorization` on any cross-origin redirect, so the
 *    request fails; blindly re-attaching it would send the app password to
 *    wherever a server points. Redirects are followed here, by hand, and
 *    credentials go only to hosts inside the account's scope.
 * 2. **Digest.** Answered from the server's challenge (see caldav-digest.ts).
 * 3. **Timeouts.** A hung server must not hang a sync pass.
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>
export type CaldavFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface CaldavCredentials {
  username: string
  password: string
}

const MAX_REDIRECTS = 5
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Providers that spread one account over several hosts inside a domain they
 * own outright (every subdomain is theirs). iCloud redirects discovery to a
 * per-account partition host (`p67-caldav.icloud.com`).
 */
const MULTI_HOST_PROVIDER_DOMAINS = [
  'icloud.com',
  'me.com',
  'fastmail.com',
  'yahoo.com',
  'zoho.com'
]

function withinDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

/**
 * The hosts that may receive this account's credentials: the exact host the
 * user connected to, plus, for a known multi-host provider, the rest of that
 * provider's own domain. Never a parent domain in general: under a shared
 * suffix (`myname.synology.me`, `family.duckdns.org`) the parent is every
 * other customer, and a PROPFIND href or an open redirect pointing there would
 * receive the app password. Credentials never travel from HTTPS to plain
 * HTTP, and plain HTTP gets them only for the exact origin the user typed (a
 * LAN server).
 */
export function createCredentialScope(serverUrl: string): (target: URL) => boolean {
  const origin = new URL(serverUrl)
  const host = origin.hostname.toLowerCase()
  const providerDomain = isIP(host)
    ? undefined
    : MULTI_HOST_PROVIDER_DOMAINS.find((domain) => withinDomain(host, domain))

  return (target) => {
    const targetHost = target.hostname.toLowerCase()
    if (target.protocol === 'http:') {
      return origin.protocol === 'http:' && target.host.toLowerCase() === origin.host.toLowerCase()
    }
    if (target.protocol !== 'https:') return false
    if (targetHost === host) return true
    return providerDomain !== undefined && withinDomain(targetHost, providerDomain)
  }
}

function toUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function basicAuthorization({ username, password }: CaldavCredentials): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

export interface CaldavTransport {
  fetch: CaldavFetch
  /** Whether the server asked for Digest; for status and diagnostics only. */
  usesDigest(): boolean
  /**
   * The last error status a request ended with, after auth retries. `tsdav`
   * turns some failures into plain `Error`s; this keeps the status that
   * decides between "wrong password" and "server down".
   */
  lastFailure(): { status: number; retryAfter: string | null } | null
}

export function createCaldavTransport(options: {
  serverUrl: string
  credentials: CaldavCredentials
  fetchImpl?: FetchLike
  timeoutMs?: number
}): CaldavTransport {
  const baseFetch: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init))
  const inScope = createCredentialScope(options.serverUrl)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let digest: DigestChallenge | null = null
  let nonceCount = 0
  let lastFailure: { status: number; retryAfter: string | null } | null = null

  function authorizationFor(target: URL, method: string): string | null {
    if (!inScope(target)) return null
    if (!digest) return basicAuthorization(options.credentials)
    nonceCount += 1
    return digestAuthorization({
      challenge: digest,
      username: options.credentials.username,
      password: options.credentials.password,
      method,
      uri: `${target.pathname}${target.search}`,
      nonceCount
    })
  }

  async function send(url: URL, init: RequestInit, method: string): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.delete('authorization')
    const authorization = authorizationFor(url, method)
    if (authorization) headers.set('Authorization', authorization)
    const signals = [AbortSignal.timeout(timeoutMs), init.signal].filter(
      (signal): signal is AbortSignal => Boolean(signal)
    )
    return await baseFetch(url.href, {
      ...init,
      method,
      headers,
      redirect: 'manual',
      signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals)
    })
  }

  async function sendWithAuth(url: URL, init: RequestInit, method: string): Promise<Response> {
    const response = await send(url, init, method)
    if (response.status !== 401 || !inScope(url)) return response
    const challenge = parseDigestChallenge(response.headers.get('www-authenticate'))
    // A fresh challenge (first contact, or a stale nonce) earns one retry.
    if (!challenge || (digest && digest.nonce === challenge.nonce)) return response
    digest = challenge
    nonceCount = 0
    await response.body?.cancel()
    return await send(url, init, method)
  }

  const caldavFetch: CaldavFetch = async (input, init = {}) => {
    let url = new URL(toUrl(input))
    let method = (init.method ?? 'GET').toUpperCase()
    let body = init.body
    const followManually = init.redirect !== 'manual'

    for (let hop = 0; ; hop += 1) {
      const response = await sendWithAuth(url, { ...init, body }, method)
      if (response.status >= 400 && response.status !== 404) {
        lastFailure = { status: response.status, retryAfter: response.headers.get('retry-after') }
      } else if (response.ok) {
        lastFailure = null
      }
      if (!isRedirect(response.status) || !followManually) return response
      const location = response.headers.get('location')
      if (!location || hop >= MAX_REDIRECTS) return response
      await response.body?.cancel()
      url = new URL(location, url)
      if (response.status === 303) {
        method = 'GET'
        body = undefined
      }
    }
  }

  return {
    fetch: caldavFetch,
    usesDigest: () => digest !== null,
    lastFailure: () => lastFailure
  }
}
