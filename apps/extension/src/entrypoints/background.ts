import type { CaptureResponse, PairResponse, PopupMessage, StatusResponse } from '@/lib/messages'
import type { ArticleCapture } from '@memry/article-extract'
import { claimToken, pollUntil, postCapture, probeServer } from '@/lib/capture-client'

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

// The popup opens memry://pair (which prompts the desktop confirm + 120s claim
// window); we poll /pair/claim until it returns the token or the window lapses.
async function startPair(): Promise<PairResponse> {
  const found = await probeServer()
  if (!found) return { ok: false }
  const token = await pollUntil(() => claimToken(found.port), {
    intervalMs: 1500,
    timeoutMs: 120_000
  })
  if (!token) return { ok: false }
  await setToken(token)
  return { ok: true }
}

async function capture(body: ArticleCapture): Promise<CaptureResponse> {
  const found = await probeServer()
  if (!found) return { ok: false, error: 'network' }
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
      case 'START_PAIR':
        return startPair()
      case 'CAPTURE':
        return capture(message.capture)
      default:
        return undefined
    }
  })
})
