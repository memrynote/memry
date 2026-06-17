import type {
  CaptureResponse,
  PageMetrics,
  PairResponse,
  PopupMessage,
  ScreenshotResponse,
  StatusResponse
} from '@/lib/messages'
import type { ArticleCapture } from '@memry/article-extract'
import { claimToken, pollUntil, postCapture, probeServer, requestPair } from '@/lib/capture-client'
import { bytesToDataUrl, planStitch } from '@/lib/capture-modes'

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

// ponytail: best-effort cap on full-page height; very tall photo-heavy pages may still exceed
// /capture's 25MB body cap (base64 inflates the bytes) and 413. Upgrade path: downscale or JPEG-encode.
const MAX_SHOT_HEIGHT = 15000
const SETTLE_MS = 400 // wait between scroll and capture; also honors captureVisibleTab's ~2/sec limit

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function grabScreenshot(): Promise<ScreenshotResponse> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id || tab.windowId == null) return { ok: false, error: 'no-tab' }
  const tabId = tab.id
  const windowId = tab.windowId
  try {
    const metrics = (await browser.tabs.sendMessage(tabId, {
      type: 'GET_PAGE_METRICS'
    })) as PageMetrics | undefined
    if (!metrics) return { ok: false, error: 'no-metrics' }
    const plan = planStitch({ ...metrics, maxHeight: MAX_SHOT_HEIGHT })
    const canvas = new OffscreenCanvas(plan.width, plan.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) return { ok: false, error: 'no-canvas' }
    try {
      for (const slice of plan.slices) {
        await browser.tabs.sendMessage(tabId, { type: 'SCROLL_TO', y: slice.scrollY })
        await sleep(SETTLE_MS)
        const shot = await browser.tabs.captureVisibleTab(windowId, { format: 'png' })
        const bmp = await createImageBitmap(await (await fetch(shot)).blob())
        ctx.drawImage(bmp, 0, slice.drawY)
        bmp.close()
      }
    } finally {
      // Always restore the user's scroll position, even if a capture threw.
      await browser.tabs
        .sendMessage(tabId, { type: 'SCROLL_TO', y: metrics.scrollY })
        .catch(() => {})
    }
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    const bytes = new Uint8Array(await blob.arrayBuffer())
    return { ok: true, dataUrl: bytesToDataUrl(bytes, 'image/png') }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
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
      case 'GRAB_SCREENSHOT':
        return grabScreenshot()
      default:
        return undefined
    }
  })
})
