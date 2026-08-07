/**
 * Microsoft account auth for the OneNote importer.
 *
 * Auth-code + PKCE flow for a public desktop client (no client secret),
 * mirroring `calendar/google/oauth.ts`: an ephemeral loopback HTTP server
 * receives the redirect, the state is single-use with a 10-minute expiry, and
 * the consent screen opens in the system browser. Tokens live in Memry's
 * secret storage (Electron `safeStorage` with keytar fallback) under a
 * dedicated service id, suffixed with `MEMRY_DEVICE` so parallel dev profiles
 * do not clobber each other.
 *
 * The importer itself only ever calls {@link getOneNoteAccessToken}, which
 * serves a cached access token until shortly before expiry and then refreshes
 * from the stored refresh token.
 *
 * @module main/import/onenote/onenote-auth
 */

import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { shell } from 'electron'
import { z } from 'zod'
import { createLogger } from '../../lib/logger'
import { markExpectedCondition } from '../../telemetry/expected-conditions'
import { getSecret, setSecret, deleteSecret } from '../../secrets/secret-storage'

const logger = createLogger('OneNoteImport')

const SERVICE = 'com.memry.import.onenote'

/** Default keychain account — the importer tracks a single Microsoft account. */
export const DEFAULT_ACCOUNT_ID = '__memry_onenote__'

/** Microsoft Graph OAuth endpoints (common tenant — personal + work/school). */
export const MS_AUTHORIZE_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
export const MS_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
const MS_ME_URL = 'https://graph.microsoft.com/v1.0/me'

/** Scopes required to read OneNote content. `offline_access` yields a refresh token. */
export const MS_SCOPES = ['offline_access', 'user.read', 'notes.read']

const OAUTH_TIMEOUT_MS = 10 * 60 * 1000
/** Refresh the access token this long before its reported expiry. */
const EXPIRY_MARGIN_MS = 60 * 1000

/**
 * Azure app registration (public client). Configured via environment; until it
 * is set the importer is not registered at all (see `register-builtins.ts`).
 * The registration needs `http://localhost` as a "Mobile and desktop
 * applications" redirect URI (Azure ignores the loopback port).
 */
export function resolveOneNoteClientId(): string | null {
  return process.env.ONENOTE_CLIENT_ID?.trim() || null
}

/** True when an Azure client id is configured for this install. */
export function isOneNoteConfigured(): boolean {
  return resolveOneNoteClientId() !== null
}

export interface OneNoteAccount {
  name: string
  email: string
}

export interface OneNoteAuthStatus {
  configured: boolean
  connected: boolean
  account: OneNoteAccount | null
}

type OneNoteSecretKind = 'access-token' | 'refresh-token' | 'profile'

function accountKey(accountId: string, kind: OneNoteSecretKind): string {
  if (!accountId || !accountId.trim()) {
    throw new Error('accountKey requires a non-empty accountId')
  }
  const deviceSuffix = process.env.MEMRY_DEVICE
  const base = `${kind}-${accountId}`
  return deviceSuffix ? `${base}-${deviceSuffix}` : base
}

async function writeSecret(
  accountId: string,
  kind: OneNoteSecretKind,
  value: string | null
): Promise<void> {
  const account = accountKey(accountId, kind)
  if (!value || value.trim().length === 0) {
    await deleteSecret(SERVICE, account)
    return
  }
  await setSecret(SERVICE, account, value.trim())
}

async function readSecret(accountId: string, kind: OneNoteSecretKind): Promise<string | null> {
  return getSecret(SERVICE, accountKey(accountId, kind))
}

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive().optional()
})

const MeResponseSchema = z.object({
  displayName: z.string().optional().nullable(),
  mail: z.string().optional().nullable(),
  userPrincipalName: z.string().optional().nullable()
})

interface CachedAccessToken {
  token: string
  expiresAt: number
}

const accessTokenCache = new Map<string, CachedAccessToken>()

interface OAuthSession {
  state: string
  redirectUri: string
  codeVerifier: string
  createdAt: number
}

const sessions = new Map<string, OAuthSession>()
let activeLoopbackServer: http.Server | null = null
let activeTimeout: ReturnType<typeof setTimeout> | null = null
/** Rejects the in-flight sign-in, so tearing its server down never strands the
 * IPC call that started it. */
let abortActiveFlow: ((error: Error) => void) | null = null

function toBase64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function createCodeVerifier(): string {
  return toBase64Url(randomBytes(64))
}

function createCodeChallenge(codeVerifier: string): string {
  return toBase64Url(createHash('sha256').update(codeVerifier).digest())
}

function createState(): string {
  return toBase64Url(randomBytes(24))
}

function cleanExpiredSessions(): void {
  const now = Date.now()
  for (const [state, session] of sessions) {
    if (now - session.createdAt > OAUTH_TIMEOUT_MS) {
      sessions.delete(state)
    }
  }
}

function clearActiveTimeout(): void {
  if (activeTimeout) {
    clearTimeout(activeTimeout)
    activeTimeout = null
  }
}

function shutdownLoopbackServer(): void {
  clearActiveTimeout()
  if (activeLoopbackServer) {
    activeLoopbackServer.close()
    activeLoopbackServer = null
  }
}

/** Tear down a still-running sign-in and settle whoever is awaiting it. */
function cancelActiveFlow(reason: string): void {
  const abort = abortActiveFlow
  abortActiveFlow = null
  shutdownLoopbackServer()
  abort?.(new Error(reason))
}

function consumeSession(state: string): OAuthSession {
  const session = sessions.get(state)
  if (!session) {
    throw new Error('Invalid or expired Microsoft OAuth state')
  }
  if (Date.now() - session.createdAt > OAUTH_TIMEOUT_MS) {
    sessions.delete(state)
    throw new Error('Microsoft sign-in session expired')
  }
  sessions.delete(state)
  return session
}

function getCallbackHtml(heading: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>memrynote</title></head>
<body><h1>${heading}</h1><p>You can close this window and return to memrynote.</p></body></html>`
}

async function startLoopbackServer(): Promise<{ server: http.Server; port: number }> {
  return await new Promise((resolve, reject) => {
    const server = http.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Failed to bind Microsoft OAuth callback server'))
        return
      }
      resolve({ server, port: address.port })
    })
    server.on('error', reject)
  })
}

/** Build the Microsoft authorize URL (PKCE, loopback redirect). */
export function buildAuthorizeUrl(input: {
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
}): string {
  const authUrl = new URL(MS_AUTHORIZE_URL)
  authUrl.searchParams.set('client_id', input.clientId)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('response_mode', 'query')
  authUrl.searchParams.set('redirect_uri', input.redirectUri)
  authUrl.searchParams.set('scope', MS_SCOPES.join(' '))
  authUrl.searchParams.set('state', input.state)
  authUrl.searchParams.set('code_challenge', input.codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  return authUrl.toString()
}

interface TokenErrorBody {
  error?: string
  error_description?: string
}

async function postToken(
  body: URLSearchParams
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
  const response = await fetch(MS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })

  // fetch resolves on 4xx/5xx, so the status decides how the body is read: an
  // error response carries an OAuth error payload, never a token. Reading it
  // first would lose the status for any body that is not JSON (a gateway's
  // HTML error page), leaving the user with a bare "sign-in failed".
  if (!response.ok) {
    const err = ((await response.json().catch(() => ({}))) ?? {}) as TokenErrorBody
    logger.error('Microsoft token request failed', {
      status: response.status,
      error: err.error,
      description: err.error_description
    })
    throw new Error(
      err.error_description || err.error || `Microsoft sign-in failed (HTTP ${response.status})`
    )
  }

  const parsed = TokenResponseSchema.safeParse(await response.json().catch(() => ({})))
  if (!parsed.success) {
    logger.error('Microsoft token response was not in the expected shape', {
      status: response.status
    })
    throw new Error('Microsoft sign-in failed')
  }

  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresIn: parsed.data.expires_in
  }
}

async function storeTokens(input: {
  accountId: string
  accessToken: string
  refreshToken?: string
  expiresIn?: number
}): Promise<void> {
  accessTokenCache.set(input.accountId, {
    token: input.accessToken,
    expiresAt: Date.now() + (input.expiresIn ?? 3600) * 1000
  })
  await writeSecret(input.accountId, 'access-token', input.accessToken)
  if (input.refreshToken) {
    await writeSecret(input.accountId, 'refresh-token', input.refreshToken)
  }
}

/**
 * Refresh the access token from the stored refresh token and persist it.
 * Exported for the Graph client's 401 path; regular callers should use
 * {@link getOneNoteAccessToken}.
 */
export async function refreshAccessToken(input: {
  clientId: string
  accountId?: string
}): Promise<string> {
  const accountId = input.accountId ?? DEFAULT_ACCOUNT_ID
  const refreshToken = await readSecret(accountId, 'refresh-token')
  if (!refreshToken) {
    throw new Error('OneNote is not connected (no refresh token). Sign in first.')
  }
  const tokens = await postToken(
    new URLSearchParams({
      client_id: input.clientId,
      grant_type: 'refresh_token',
      scope: MS_SCOPES.join(' '),
      refresh_token: refreshToken
    })
  )
  await storeTokens({
    accountId,
    accessToken: tokens.accessToken,
    // Microsoft rotates refresh tokens; keep the old one when none is returned.
    refreshToken: tokens.refreshToken ?? refreshToken,
    expiresIn: tokens.expiresIn
  })
  return tokens.accessToken
}

/**
 * Resolve a bearer token for Graph calls: cached until shortly before expiry,
 * then refreshed from the stored refresh token.
 */
export async function getOneNoteAccessToken(input: {
  clientId: string
  accountId?: string
  forceRefresh?: boolean
}): Promise<string> {
  const accountId = input.accountId ?? DEFAULT_ACCOUNT_ID
  if (!input.forceRefresh) {
    const cached = accessTokenCache.get(accountId)
    if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
      return cached.token
    }
  }
  return refreshAccessToken({ clientId: input.clientId, accountId })
}

async function fetchProfile(accessToken: string): Promise<OneNoteAccount> {
  const response = await fetch(MS_ME_URL, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    logger.error('Failed to fetch Microsoft profile', {
      status: response.status,
      body: body.slice(0, 300)
    })
    throw new Error(`Could not read the Microsoft account profile (${response.status})`)
  }
  const parsed = MeResponseSchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new Error('Unexpected Microsoft profile response')
  }
  return {
    name: parsed.data.displayName ?? '',
    email: parsed.data.mail ?? parsed.data.userPrincipalName ?? ''
  }
}

/**
 * Run the interactive sign-in: open the consent screen in the browser, wait
 * for the loopback callback, exchange the code (PKCE) and persist tokens +
 * profile. Resolves with the signed-in account.
 */
export async function connectOneNote(): Promise<OneNoteAccount> {
  const clientId = resolveOneNoteClientId()
  if (!clientId) {
    throw new Error('OneNote import is not configured (missing ONENOTE_CLIENT_ID).')
  }

  cleanExpiredSessions()
  // A second sign-in supersedes the first; settle it instead of closing its
  // server underneath a promise nobody will ever resolve.
  cancelActiveFlow('Microsoft sign-in was restarted')

  const { server, port } = await startLoopbackServer()
  logger.info('OneNote OAuth loopback on port', port)
  activeLoopbackServer = server

  // Path-less loopback redirect: the Azure "Mobile and desktop applications"
  // platform registers `http://localhost` and ignores the port.
  const redirectUri = `http://localhost:${port}`
  const state = createState()
  const codeVerifier = createCodeVerifier()
  const codeChallenge = createCodeChallenge(codeVerifier)

  sessions.set(state, { state, redirectUri, codeVerifier, createdAt: Date.now() })

  const callbackPromise = new Promise<{ code: string; codeVerifier: string }>((resolve, reject) => {
    let settled = false
    const settle = <T>(fn: (value: T) => void, value: T): void => {
      if (settled) return
      settled = true
      abortActiveFlow = null
      fn(value)
    }
    abortActiveFlow = (error) => settle(reject, error)

    activeTimeout = setTimeout(() => {
      sessions.delete(state)
      shutdownLoopbackServer()
      // The user opened the consent screen and walked away. Normal state, not
      // a fault: the UI still reports it, telemetry does not.
      settle(reject, markExpectedCondition(new Error('Microsoft sign-in timed out')))
    }, OAUTH_TIMEOUT_MS)

    server.on('request', (req, res) => {
      const requestUrl = new URL(req.url ?? '/', redirectUri)

      // The ephemeral port can receive unrelated traffic (a security scanner,
      // a browser prefetch) while the consent screen is open. Anything that
      // is not the OAuth redirect gets a 404 and must NOT settle the flow, or
      // the real callback lands on a closed server.
      if (!requestUrl.searchParams.has('code') && !requestUrl.searchParams.has('error')) {
        res.writeHead(404)
        res.end()
        return
      }

      const oauthError = requestUrl.searchParams.get('error')
      if (oauthError) {
        const callbackState = requestUrl.searchParams.get('state')
        if (callbackState) sessions.delete(callbackState)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(getCallbackHtml('Microsoft sign-in failed'))
        shutdownLoopbackServer()
        settle(reject, new Error(`Microsoft sign-in failed: ${oauthError}`))
        return
      }

      const code = requestUrl.searchParams.get('code')
      const callbackState = requestUrl.searchParams.get('state')
      if (!code || !callbackState) {
        sessions.delete(state)
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(getCallbackHtml('Microsoft sign-in failed'))
        shutdownLoopbackServer()
        settle(reject, new Error('Microsoft OAuth callback missing code or state'))
        return
      }

      let session: OAuthSession
      try {
        session = consumeSession(callbackState)
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(getCallbackHtml('Microsoft sign-in failed'))
        shutdownLoopbackServer()
        settle(reject, error)
        return
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(getCallbackHtml('OneNote connected'))
      shutdownLoopbackServer()
      settle(resolve, { code, codeVerifier: session.codeVerifier })
    })

    server.on('error', (error) => {
      sessions.delete(state)
      shutdownLoopbackServer()
      settle(reject, error)
    })
  })

  const authUrl = buildAuthorizeUrl({ clientId, redirectUri, state, codeChallenge })
  logger.info('Opening Microsoft consent screen')
  try {
    await shell.openExternal(authUrl)
  } catch (error) {
    // Nothing will ever reach the callback; tear the flow down now instead of
    // leaving the port held and the 10-minute timer armed on a dead promise.
    sessions.delete(state)
    cancelActiveFlow('Could not open the Microsoft sign-in page')
    throw error
  }

  const callback = await callbackPromise

  const tokens = await postToken(
    new URLSearchParams({
      client_id: clientId,
      grant_type: 'authorization_code',
      scope: MS_SCOPES.join(' '),
      code: callback.code,
      redirect_uri: redirectUri,
      code_verifier: callback.codeVerifier
    })
  )
  if (!tokens.refreshToken) {
    throw new Error('Microsoft sign-in did not return a refresh token')
  }

  await storeTokens({
    accountId: DEFAULT_ACCOUNT_ID,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn
  })

  // The account is connected once the tokens are stored. A failing /me lookup
  // is cosmetic — reporting it as a failed sign-in would contradict the stored
  // refresh token the next status check finds.
  let account: OneNoteAccount = { name: '', email: '' }
  try {
    account = await fetchProfile(tokens.accessToken)
    await writeSecret(DEFAULT_ACCOUNT_ID, 'profile', JSON.stringify(account))
  } catch (error) {
    logger.warn('Connected, but could not read the Microsoft profile', { error })
  }
  logger.info('OneNote connected', { hasEmail: account.email.length > 0 })
  return account
}

/** Current auth state for the renderer's OneNote panel. */
export async function getOneNoteAuthStatus(): Promise<OneNoteAuthStatus> {
  const configured = isOneNoteConfigured()
  if (!configured) return { configured, connected: false, account: null }

  const refreshToken = await readSecret(DEFAULT_ACCOUNT_ID, 'refresh-token')
  if (!refreshToken) return { configured, connected: false, account: null }

  let account: OneNoteAccount | null = null
  const profileRaw = await readSecret(DEFAULT_ACCOUNT_ID, 'profile')
  if (profileRaw) {
    try {
      const parsed = JSON.parse(profileRaw) as Partial<OneNoteAccount>
      account = { name: parsed.name ?? '', email: parsed.email ?? '' }
    } catch {
      account = null
    }
  }
  return { configured, connected: true, account }
}

/**
 * Forget the Microsoft account: clear tokens + profile locally. Microsoft has
 * no revoke endpoint for public clients; the grant stays visible to the user
 * at account.microsoft.com until they remove it there.
 */
export async function disconnectOneNote(): Promise<void> {
  accessTokenCache.delete(DEFAULT_ACCOUNT_ID)
  await writeSecret(DEFAULT_ACCOUNT_ID, 'access-token', null)
  await writeSecret(DEFAULT_ACCOUNT_ID, 'refresh-token', null)
  await writeSecret(DEFAULT_ACCOUNT_ID, 'profile', null)
}

/** Test-only: clear module state between cases. */
export function __resetOneNoteAuthForTests(): void {
  sessions.clear()
  accessTokenCache.clear()
  cancelActiveFlow('Microsoft sign-in was cancelled')
}
