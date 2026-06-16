/**
 * Secure token storage for the OneNote (Microsoft Graph) importer.
 *
 * Mirrors `calendar/google/keychain.ts`: tokens live in the OS keychain via
 * keytar under a dedicated service id, keyed per Microsoft account, with the
 * same `MEMRY_DEVICE` suffixing so parallel dev profiles do not clobber each
 * other.
 *
 * The OAuth *flow* itself (auth-code via a loopback redirect, mirroring
 * `ipc/auth-oauth-handlers.ts`) lives in {@link buildAuthorizeUrl} /
 * {@link exchangeCodeForTokens} / {@link refreshAccessToken}. No client secret
 * is hardcoded — the public-client/PKCE-style flow Microsoft uses for desktop
 * apps needs only the client id (see ONENOTE_CLIENT_ID config gap).
 *
 * @module main/import/onenote/onenote-auth
 */

import keytar from 'keytar'
import { createLogger } from '../../lib/logger'

const logger = createLogger('OneNoteImport')

const SERVICE = 'com.memry.import.onenote'

/** Default keychain account when the importer does not track multiple users. */
export const DEFAULT_ACCOUNT_ID = '__memry_onenote__'

/** Microsoft Graph OAuth endpoints (common tenant — personal + work/school). */
export const MS_AUTHORIZE_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
export const MS_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'

/** Scopes required to read OneNote content. `offline_access` yields a refresh token. */
export const MS_SCOPES = ['offline_access', 'user.read', 'notes.read']

export type OneNoteTokenKind = 'access-token' | 'refresh-token'

function accountKey(accountId: string, kind: OneNoteTokenKind): string {
  if (!accountId || !accountId.trim()) {
    throw new Error('accountKey requires a non-empty accountId')
  }
  const deviceSuffix = process.env.MEMRY_DEVICE
  const base = `${kind}-${accountId}`
  return deviceSuffix ? `${base}-${deviceSuffix}` : base
}

async function setPassword(
  accountId: string,
  kind: OneNoteTokenKind,
  value: string | null
): Promise<void> {
  const account = accountKey(accountId, kind)
  if (!value || value.trim().length === 0) {
    await keytar.deletePassword(SERVICE, account)
    return
  }
  await keytar.setPassword(SERVICE, account, value.trim())
}

async function getPassword(accountId: string, kind: OneNoteTokenKind): Promise<string | null> {
  return keytar.getPassword(SERVICE, accountKey(accountId, kind))
}

export async function storeOneNoteTokens(input: {
  accountId?: string
  accessToken: string
  refreshToken?: string
}): Promise<void> {
  const accountId = input.accountId ?? DEFAULT_ACCOUNT_ID
  await setPassword(accountId, 'access-token', input.accessToken)
  if (input.refreshToken) {
    await setPassword(accountId, 'refresh-token', input.refreshToken)
  }
}

export async function getOneNoteTokens(accountId: string = DEFAULT_ACCOUNT_ID): Promise<{
  accessToken: string | null
  refreshToken: string | null
}> {
  const [accessToken, refreshToken] = await Promise.all([
    getPassword(accountId, 'access-token'),
    getPassword(accountId, 'refresh-token')
  ])
  return { accessToken, refreshToken }
}

export async function clearOneNoteTokens(accountId: string = DEFAULT_ACCOUNT_ID): Promise<void> {
  await Promise.all([
    setPassword(accountId, 'access-token', null),
    setPassword(accountId, 'refresh-token', null)
  ])
}

/**
 * Build the Microsoft authorize URL for the loopback auth-code flow. The
 * redirect URI must be one registered on the Azure app (typically a loopback
 * `http://127.0.0.1:<port>` address, matching Memry's existing Google flow).
 *
 * TODO(onenote, before enabling — see PR "Blockers"): this scaffold still needs
 * (1) PKCE (`code_challenge`/`code_verifier`, S256) on the authorize + token
 * exchange, matching Memry's Google flow — required for a public desktop client;
 * (2) access-token caching keyed on `expires_in` so `getAccessToken()` does not
 * POST the token endpoint on every Graph request. Both require a live Azure app
 * registration to verify, so they are deferred to that manual-QA pass.
 */
export function buildAuthorizeUrl(input: {
  clientId: string
  redirectUri: string
  state: string
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    response_type: 'code',
    response_mode: 'query',
    redirect_uri: input.redirectUri,
    scope: MS_SCOPES.join(' '),
    state: input.state
  })
  return `${MS_AUTHORIZE_URL}?${params.toString()}`
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

async function postToken(
  body: URLSearchParams
): Promise<{ accessToken: string; refreshToken?: string }> {
  const response = await fetch(MS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
  const json = (await response.json().catch(() => ({}))) as TokenResponse
  if (!response.ok || !json.access_token) {
    logger.error('Microsoft token request failed', {
      status: response.status,
      error: json.error,
      description: json.error_description
    })
    throw new Error(json.error_description || json.error || 'Microsoft sign-in failed')
  }
  return { accessToken: json.access_token, refreshToken: json.refresh_token }
}

/** Exchange an auth code (from the loopback callback) for tokens and persist them. */
export async function exchangeCodeForTokens(input: {
  clientId: string
  redirectUri: string
  code: string
  accountId?: string
}): Promise<string> {
  const { accessToken, refreshToken } = await postToken(
    new URLSearchParams({
      client_id: input.clientId,
      grant_type: 'authorization_code',
      redirect_uri: input.redirectUri,
      scope: MS_SCOPES.join(' '),
      code: input.code
    })
  )
  await storeOneNoteTokens({ accountId: input.accountId, accessToken, refreshToken })
  return accessToken
}

/** Refresh the access token from the stored refresh token and persist it. */
export async function refreshAccessToken(input: {
  clientId: string
  accountId?: string
}): Promise<string> {
  const accountId = input.accountId ?? DEFAULT_ACCOUNT_ID
  const { refreshToken } = await getOneNoteTokens(accountId)
  if (!refreshToken) {
    throw new Error('OneNote is not connected (no refresh token).')
  }
  const tokens = await postToken(
    new URLSearchParams({
      client_id: input.clientId,
      grant_type: 'refresh_token',
      scope: MS_SCOPES.join(' '),
      refresh_token: refreshToken
    })
  )
  const nextRefresh = tokens.refreshToken ?? refreshToken
  await storeOneNoteTokens({
    accountId,
    accessToken: tokens.accessToken,
    refreshToken: nextRefresh
  })
  return tokens.accessToken
}
