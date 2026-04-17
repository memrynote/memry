import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { shell } from 'electron'
import { z } from 'zod'
import { createLogger } from '../../lib/logger'
import type { DataDb } from '../../database/types'
import { listCalendarSources } from '../repositories/calendar-sources-repository'
import {
  clearGoogleCalendarTokens,
  getGoogleCalendarTokens,
  storeGoogleCalendarTokens
} from './keychain'

const log = createLogger('Calendar:GoogleOAuth')

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const GOOGLE_PRIMARY_CALENDAR_URL =
  'https://www.googleapis.com/calendar/v3/users/me/calendarList/primary'
const OAUTH_TIMEOUT_MS = 10 * 60 * 1000

export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar'
const GOOGLE_IDENTITY_SCOPES = ['openid', 'email', 'profile']
const GOOGLE_ALL_SCOPES = [...GOOGLE_IDENTITY_SCOPES, GOOGLE_CALENDAR_SCOPE]

const GoogleTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  scope: z.string().min(1),
  token_type: z.string().min(1)
})

const GooglePrimaryCalendarSchema = z.object({
  id: z.string().min(1),
  summary: z.string().optional(),
  timeZone: z.string().optional(),
  backgroundColor: z.string().optional(),
  primary: z.boolean().optional()
})

interface GoogleOAuthSession {
  state: string
  redirectUri: string
  codeVerifier: string
  createdAt: number
}

export interface GoogleCalendarConnection {
  account: {
    remoteId: string
    title: string
    timezone: string | null
  }
  primaryCalendar: {
    remoteId: string
    title: string
    timezone: string | null
    color: string | null
    isPrimary: boolean
  }
}

const sessions = new Map<string, GoogleOAuthSession>()
let activeLoopbackServer: http.Server | null = null
let activeTimeout: ReturnType<typeof setTimeout> | null = null

function resolveGoogleClientId(): string {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID?.trim()
  if (!clientId) {
    throw new Error('Missing GOOGLE_CALENDAR_CLIENT_ID')
  }
  return clientId
}

function resolveGoogleClientSecret(): string | undefined {
  return process.env.GOOGLE_CALENDAR_CLIENT_SECRET?.trim() || undefined
}

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

function consumeSession(state: string): GoogleOAuthSession {
  const session = sessions.get(state)
  if (!session) {
    throw new Error('Invalid or expired Google Calendar OAuth state')
  }
  if (Date.now() - session.createdAt > OAUTH_TIMEOUT_MS) {
    sessions.delete(state)
    throw new Error('Google Calendar OAuth session expired')
  }
  sessions.delete(state)
  return session
}

function getSuccessHtml(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Memry</title></head>
<body><h1>Google Calendar connected</h1><p>You can close this window and return to Memry.</p></body></html>`
}

function getErrorHtml(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Memry</title></head>
<body><h1>Google Calendar connection failed</h1><p>You can close this window and return to Memry.</p></body></html>`
}

async function startLoopbackServer(): Promise<{ server: http.Server; port: number }> {
  return await new Promise((resolve, reject) => {
    const server = http.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Failed to bind Google Calendar OAuth callback server'))
        return
      }

      resolve({ server, port: address.port })
    })
    server.on('error', reject)
  })
}

async function exchangeCodeForTokens(input: {
  code: string
  redirectUri: string
  codeVerifier: string
  clientId: string
  clientSecret?: string
}): Promise<z.infer<typeof GoogleTokenResponseSchema>> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    code: input.code,
    code_verifier: input.codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: input.redirectUri
  })
  if (input.clientSecret) {
    body.set('client_secret', input.clientSecret)
  }

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  })

  if (!response.ok) {
    throw new Error(`Google Calendar token exchange failed with status ${response.status}`)
  }

  return GoogleTokenResponseSchema.parse(await response.json())
}

async function fetchPrimaryCalendar(
  accessToken: string
): Promise<z.infer<typeof GooglePrimaryCalendarSchema>> {
  const response = await fetch(GOOGLE_PRIMARY_CALENDAR_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  })

  if (!response.ok) {
    throw new Error(`Failed to fetch Google Calendar metadata (${response.status})`)
  }

  return GooglePrimaryCalendarSchema.parse(await response.json())
}

export async function connectGoogleCalendar(): Promise<GoogleCalendarConnection> {
  cleanExpiredSessions()
  shutdownLoopbackServer()

  const clientId = resolveGoogleClientId()
  const clientSecret = resolveGoogleClientSecret()
  const { server, port } = await startLoopbackServer()
  log.info('OAuth loopback on port', port)
  activeLoopbackServer = server

  const redirectUri = `http://127.0.0.1:${port}/callback`
  const state = createState()
  const codeVerifier = createCodeVerifier()
  const codeChallenge = createCodeChallenge(codeVerifier)

  sessions.set(state, {
    state,
    redirectUri,
    codeVerifier,
    createdAt: Date.now()
  })

  const callbackPromise = new Promise<{ code: string; state: string }>((resolve, reject) => {
    let settled = false

    const settle = (fn: (value: any) => void, value: unknown): void => {
      if (settled) return
      settled = true
      fn(value)
    }

    activeTimeout = setTimeout(() => {
      sessions.delete(state)
      shutdownLoopbackServer()
      settle(reject, new Error('Google Calendar OAuth timed out'))
    }, OAUTH_TIMEOUT_MS)

    server.on('request', (req, res) => {
      const requestUrl = new URL(req.url ?? '/', redirectUri)
      if (requestUrl.pathname !== '/callback') {
        res.writeHead(404)
        res.end()
        return
      }

      const oauthError = requestUrl.searchParams.get('error')
      if (oauthError) {
        const callbackState = requestUrl.searchParams.get('state')
        if (callbackState) {
          sessions.delete(callbackState)
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(getErrorHtml())
        shutdownLoopbackServer()
        settle(reject, new Error(`Google Calendar OAuth failed: ${oauthError}`))
        return
      }

      const code = requestUrl.searchParams.get('code')
      const callbackState = requestUrl.searchParams.get('state')

      if (!code || !callbackState) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(getErrorHtml())
        shutdownLoopbackServer()
        settle(reject, new Error('Google Calendar OAuth callback missing code or state'))
        return
      }

      try {
        consumeSession(callbackState)
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(getErrorHtml())
        shutdownLoopbackServer()
        settle(reject, error)
        return
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(getSuccessHtml())
      shutdownLoopbackServer()
      settle(resolve, { code, state: callbackState })
    })

    server.on('error', (error) => {
      sessions.delete(state)
      shutdownLoopbackServer()
      settle(reject, error)
    })
  })

  const authUrl = buildGoogleCalendarAuthUrl({
    clientId,
    redirectUri,
    state,
    codeChallenge
  })

  log.info('Opening Google OAuth consent screen')
  await shell.openExternal(authUrl)

  const callbackResult = await callbackPromise

  const tokenResponse = await exchangeCodeForTokens({
    code: callbackResult.code,
    redirectUri,
    codeVerifier,
    clientId,
    clientSecret
  })

  const existingTokens = await getGoogleCalendarTokens()
  const refreshToken = tokenResponse.refresh_token ?? existingTokens.refreshToken
  if (!refreshToken) {
    throw new Error('Google Calendar OAuth did not return a refresh token')
  }

  await storeGoogleCalendarTokens({
    accessToken: tokenResponse.access_token,
    refreshToken
  })

  const primaryCalendar = await fetchPrimaryCalendar(tokenResponse.access_token)
  const title = primaryCalendar.summary ?? primaryCalendar.id
  const timezone = primaryCalendar.timeZone ?? null

  return {
    account: {
      remoteId: primaryCalendar.id,
      title,
      timezone
    },
    primaryCalendar: {
      remoteId: primaryCalendar.id,
      title,
      timezone,
      color: primaryCalendar.backgroundColor ?? null,
      isPrimary: primaryCalendar.primary ?? true
    }
  }
}

export async function disconnectGoogleCalendar(): Promise<void> {
  const { refreshToken } = await getGoogleCalendarTokens()

  if (refreshToken) {
    try {
      await fetch(GOOGLE_REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refreshToken })
      })
    } catch (error) {
      log.warn('Failed to revoke Google Calendar token (non-blocking)', error)
    }
  }

  await clearGoogleCalendarTokens()
}

export async function hasGoogleCalendarLocalAuth(): Promise<boolean> {
  const { refreshToken } = await getGoogleCalendarTokens()
  return typeof refreshToken === 'string' && refreshToken.trim().length > 0
}

export async function hasGoogleCalendarConnection(db: DataDb): Promise<boolean> {
  if (!(await hasGoogleCalendarLocalAuth())) return false
  const accounts = listCalendarSources(db, { provider: 'google', kind: 'account' })
  return accounts.length > 0
}

export function buildGoogleCalendarAuthUrl(input: {
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
}): string {
  const authUrl = new URL(GOOGLE_AUTH_URL)
  authUrl.searchParams.set('client_id', input.clientId)
  authUrl.searchParams.set('redirect_uri', input.redirectUri)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', GOOGLE_ALL_SCOPES.join(' '))
  authUrl.searchParams.set('state', input.state)
  authUrl.searchParams.set('access_type', 'offline')
  authUrl.searchParams.set('prompt', 'consent')
  authUrl.searchParams.set('include_granted_scopes', 'true')
  authUrl.searchParams.set('code_challenge', input.codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  return authUrl.toString()
}

export function resetGoogleCalendarOAuthState(): void {
  sessions.clear()
  shutdownLoopbackServer()
  log.debug('Reset Google Calendar OAuth state')
}
