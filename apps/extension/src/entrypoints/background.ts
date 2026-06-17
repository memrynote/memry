import type { CaptureResponse, PairResponse, PopupMessage, StatusResponse } from '@/lib/messages'
import type { ArticleCapture } from '@memry/article-extract'
import { claimToken, pollUntil, postCapture, probeServer, requestPair } from '@/lib/capture-client'

const TOKEN_KEY = 'memry:capture-token'

async function getToken(): Promise<string | null> {
  const r = await browser.storage.local.get(TOKEN_KEY)
  const v = r[TOKEN_KEY]
  return typeof v === 'string' ? v : null
}

async function setToken(token: string): Promise<void> {
  await browser.storage.local.set({ [TOKEN_KEY]: token })
}

async function getStatus(): Promise<StatusResponse> {
  const found = await probeServer()
  if (!found) return { connection: 'app-closed', port: null }
  const token = await getToken()
  if (found.ping.paired && token) return { connection: 'ready', port: found.port }
  return { connection: 'needs-pairing', port: found.port }
}

async function pair(): Promise<PairResponse> {
  const found = await probeServer()
  if (!found) return { ok: false }
  const status = await requestPair(found.port)
  if (status === 'error') return { ok: false }
  // 'already-paired': token is available immediately — short 5s poll.
  // 'pending': desktop approval window opened; the user has 120s to Allow.
  const timeoutMs = status === 'already-paired' ? 5000 : 120_000
  const token = await pollUntil(() => claimToken(found.port), { intervalMs: 1500, timeoutMs })
  if (!token) return { ok: false }
  await setToken(token)
  return { ok: true }
}

async function waitForServer(): Promise<{ ok: boolean }> {
  const found = await pollUntil(() => probeServer(), { intervalMs: 800, timeoutMs: 20_000 })
  return { ok: found !== null }
}

async function capture(body: ArticleCapture): Promise<CaptureResponse> {
  const found = await probeServer()
  if (!found) return { ok: false, error: 'app-closed' }
  const token = await getToken()
  if (!token) return { ok: false, error: 'bad-token' }
  return postCapture(found.port, token, body)
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: PopupMessage) => {
    // Returning a Promise responds asynchronously (webextension-polyfill).
    switch (message.type) {
      case 'GET_STATUS':
        return getStatus()
      case 'PAIR':
        return pair()
      case 'CAPTURE':
        return capture(message.capture)
      case 'WAIT_FOR_SERVER':
        return waitForServer()
      default:
        return undefined
    }
  })
})
