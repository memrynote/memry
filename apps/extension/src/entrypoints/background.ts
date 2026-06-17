import type {
  CaptureResponse,
  FlushResponse,
  PageMetrics,
  PairResponse,
  PopupMessage,
  ScreenshotResponse,
  StatusResponse
} from '@/lib/messages'
import type { ArticleCapture } from '@memry/article-extract'
import { claimToken, pollUntil, postCapture, probeServer, requestPair } from '@/lib/capture-client'
import { bytesToDataUrl, planStitch } from '@/lib/capture-modes'
import {
  badgeText,
  dequeueById,
  enqueue,
  isRetryable,
  type QueuedCapture
} from '@/lib/capture-queue'

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

const QUEUE_KEY = 'memry:capture-queue'
const FLUSH_ALARM = 'memry-flush'

async function readQueue(): Promise<QueuedCapture[]> {
  const r = await browser.storage.local.get(QUEUE_KEY)
  const v = r[QUEUE_KEY]
  return Array.isArray(v) ? (v as QueuedCapture[]) : []
}

async function writeQueue(queue: QueuedCapture[]): Promise<void> {
  await browser.storage.local.set({ [QUEUE_KEY]: queue })
}

async function setBadge(count: number): Promise<void> {
  await browser.action.setBadgeText({ text: badgeText(count) })
  if (count > 0) await browser.action.setBadgeBackgroundColor({ color: '#E56458' })
}

async function ensureFlushAlarm(): Promise<void> {
  const existing = await browser.alarms.get(FLUSH_ALARM)
  if (!existing) await browser.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 })
}

async function stopFlushAlarm(): Promise<void> {
  await browser.alarms.clear(FLUSH_ALARM)
}

// Try the live server once and drain queued items oldest-first. Drop on success
// or permanent failure; stop the pass (keep the rest) the moment the server is
// unreachable again.
async function flushQueue(): Promise<FlushResponse> {
  let queue = await readQueue()
  if (queue.length === 0) {
    await stopFlushAlarm()
    return { flushed: 0, remaining: 0 }
  }
  const found = await probeServer()
  const token = await getToken()
  if (!found || !token) return { flushed: 0, remaining: queue.length }
  let flushed = 0
  for (const item of [...queue]) {
    const res = await postCapture(found.port, token, item.capture)
    if (res.ok) {
      queue = dequeueById(queue, item.id)
      flushed++
    } else if (isRetryable(res.error)) {
      break
    } else {
      console.warn('[memry] dropping unsendable queued capture', item.id, res.error)
      queue = dequeueById(queue, item.id)
    }
  }
  await writeQueue(queue)
  await setBadge(queue.length)
  if (queue.length === 0) await stopFlushAlarm()
  return { flushed, remaining: queue.length }
}

// Capture, or queue it for retry when the server is unreachable. Permanent
// errors (bad token, invalid payload) pass straight through to the popup.
async function captureOrQueue(body: ArticleCapture): Promise<CaptureResponse> {
  const res = await capture(body)
  if (res.ok) {
    void flushQueue()
    return res
  }
  if (isRetryable(res.error)) {
    const queue = enqueue(await readQueue(), {
      id: crypto.randomUUID(),
      capture: body,
      queuedAt: Date.now()
    })
    await writeQueue(queue)
    await setBadge(queue.length)
    await ensureFlushAlarm()
    return { ok: false, error: 'queued' }
  }
  return res
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: PopupMessage) => {
    switch (message.type) {
      case 'GET_STATUS':
        return getStatus().then((status) => {
          if (status.connection === 'ready') void flushQueue()
          return status
        })
      case 'PAIR':
        return pair()
      case 'CAPTURE':
        return captureOrQueue(message.capture)
      case 'WAIT_FOR_SERVER':
        return waitForServer()
      case 'GRAB_SCREENSHOT':
        return grabScreenshot()
      case 'FLUSH_QUEUE':
        return flushQueue()
      default:
        return undefined
    }
  })

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === FLUSH_ALARM) void flushQueue()
  })

  // Restore the badge + retry alarm whenever the service worker (re)starts.
  void (async () => {
    const queue = await readQueue()
    await setBadge(queue.length)
    if (queue.length > 0) await ensureFlushAlarm()
  })()
})
