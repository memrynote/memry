import type {
  CaptureResponse,
  ExtractResponse,
  FetchPdfResponse,
  FlushResponse,
  PageMetrics,
  PairResponse,
  PopupMessage,
  ScreenshotResponse,
  StatusResponse
} from '@/lib/messages'
import type { ArticleCapture } from '@memry/article-extract'
import {
  claimToken,
  pollUntil,
  postCapture,
  postRevoke,
  PROBE_PORTS,
  probeServer,
  requestPair
} from '@/lib/capture-client'
import { bytesToDataUrl, planStitch } from '@/lib/capture-modes'
import {
  badgeText,
  dequeueById,
  enqueue,
  isQueueable,
  isRetryable,
  type QueuedCapture
} from '@/lib/capture-queue'
import {
  buildPdfDraft,
  checkPdfBytes,
  checkPdfContentLength,
  pdfFilenameFrom
} from '@/lib/pdf-capture'
import { hasOriginPermission } from '@/lib/capture-permissions'

const TOKEN_KEY = 'memry:capture-token'

async function getToken(): Promise<string | null> {
  const r = await browser.storage.local.get(TOKEN_KEY)
  const v = r[TOKEN_KEY]
  return typeof v === 'string' ? v : null
}

async function setToken(token: string): Promise<void> {
  await browser.storage.local.set({ [TOKEN_KEY]: token })
}

const PORT_KEY = 'memry:capture-port'

async function getOverridePort(): Promise<number | null> {
  const r = await browser.storage.local.get(PORT_KEY)
  const v = r[PORT_KEY]
  return typeof v === 'number' && Number.isInteger(v) ? v : null
}

// Probe the override port first (if set), then the default range.
async function probe(): Promise<Awaited<ReturnType<typeof probeServer>>> {
  const override = await getOverridePort()
  return override ? probeServer(fetch, [override, ...PROBE_PORTS]) : probeServer()
}

async function revoke(): Promise<{ ok: boolean }> {
  const found = await probe()
  const token = await getToken()
  if (found && token) await postRevoke(found.port, token)
  await browser.storage.local.remove(TOKEN_KEY)
  return { ok: true }
}

async function getStatus(): Promise<StatusResponse> {
  const found = await probe()
  if (!found) return { connection: 'app-closed', port: null }
  const token = await getToken()
  if (found.ping.paired && token) return { connection: 'ready', port: found.port }
  return { connection: 'needs-pairing', port: found.port }
}

async function pair(): Promise<PairResponse> {
  const found = await probe()
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
  const found = await probe()
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

// Re-fetch the tab's PDF with the user's cookies. Content scripts never run in
// Chrome's or Firefox's PDF viewer, so re-fetching is the only way to reach the
// bytes. Requires the page origin's host permission, which the popup requests on
// the Send click.
async function fetchPdf(url: string): Promise<FetchPdfResponse> {
  try {
    const res = await fetch(url, { credentials: 'include' })
    if (!res.ok) return { ok: false, error: 'pdf-fetch-failed' }
    // Bail on a declared oversize BEFORE buffering: arrayBuffer() on a hostile or
    // mislabelled multi-gigabyte body would OOM the service worker.
    const declared = checkPdfContentLength(res.headers.get('content-length'))
    if (!declared.ok) return declared
    const bytes = new Uint8Array(await res.arrayBuffer())
    const check = checkPdfBytes(bytes)
    if (!check.ok) return check
    return {
      ok: true,
      dataUrl: bytesToDataUrl(bytes, 'application/pdf'),
      filename: pdfFilenameFrom(url, res.headers.get('content-disposition'))
    }
  } catch {
    return { ok: false, error: 'pdf-fetch-failed' }
  }
}

const QUEUE_KEY = 'memry:capture-queue'
const FLUSH_ALARM = 'memry-flush'

let flushing: Promise<FlushResponse> | null = null

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

async function restoreQueueBadge(): Promise<void> {
  await setBadge((await readQueue()).length)
}

// Brief "that didn't work" badge for the keyboard shortcut, which has no popup to
// report into. Reverts to the queue count after 2s.
async function flashErrorBadge(): Promise<void> {
  await browser.action.setBadgeText({ text: '!' })
  await browser.action.setBadgeBackgroundColor({ color: '#E56458' })
  setTimeout(() => void restoreQueueBadge(), 2000)
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
// Re-entrancy guard: concurrent callers share ONE in-flight flush pass so the
// same queued item is never POSTed twice.
function flushQueue(): Promise<FlushResponse> {
  if (flushing) return flushing
  flushing = (async (): Promise<FlushResponse> => {
    let queue = await readQueue()
    if (queue.length === 0) {
      await stopFlushAlarm()
      return { flushed: 0, remaining: 0 }
    }
    const found = await probe()
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
  })().finally(() => {
    flushing = null
  })
  return flushing
}

// Capture, or queue it for retry when the server is unreachable. Permanent
// errors (bad token, invalid payload) pass straight through to the popup.
async function captureOrQueue(body: ArticleCapture): Promise<CaptureResponse> {
  const res = await capture(body)
  if (res.ok) {
    void flushQueue()
    return res
  }
  if (isRetryable(res.error) && isQueueable(body)) {
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
      case 'FETCH_PDF':
        return fetchPdf(message.url)
      case 'FLUSH_QUEUE':
        return flushQueue()
      case 'REVOKE':
        return revoke()
      default:
        return undefined
    }
  })

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === FLUSH_ALARM) void flushQueue()
  })

  browser.commands.onCommand.addListener(async (command) => {
    if (command !== 'capture-page') return
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id) return
    // The content script is declared on *://*/* and auto-injected, so messaging
    // it needs no activeTab grant. It is absent on chrome://, the Web Store, and
    // PDFs — sendMessage rejects there, which we surface as a brief error badge.
    const extracted: ExtractResponse = await browser.tabs
      .sendMessage(tab.id, { type: 'EXTRACT' })
      .catch(() => ({ ok: false, error: 'no-content-script' }))
    let payload = extracted.ok ? extracted.capture : null
    // The content script is absent on a PDF tab. We cannot prompt for site access
    // from a service worker (no user gesture), so this only works for an origin
    // the user already approved through the popup.
    if (!payload && tab.url && (await hasOriginPermission(tab.url))) {
      const draft = buildPdfDraft({ url: tab.url, title: tab.title })
      const pdf = draft ? await fetchPdf(tab.url) : null
      if (draft && pdf?.ok) {
        payload = { ...draft, pdfDataUrl: pdf.dataUrl, pdfFilename: pdf.filename }
      }
    }
    if (!payload) {
      await flashErrorBadge()
      return
    }
    // On Firefox MV3 the loopback host permission is opt-in and can only be
    // requested from a user-gesture page — the popup — so this background
    // shortcut cannot prompt for it. Until it is granted, the loopback fetch
    // fails. A queueable capture is then stored for the retry alarm (the badge
    // shows the count) and flushes once the user grants access by saving from the
    // popup once. A PDF is NOT queueable — megabytes of base64 would blow Chrome's
    // 10MB storage.local cap — so it is simply lost, and the error badge is the
    // only signal the user gets. The same applies whenever the desktop app is
    // closed.
    const res = await captureOrQueue(payload)
    if (res.ok) {
      await browser.action.setBadgeText({ text: '✓' })
      await browser.action.setBadgeBackgroundColor({ color: '#3B873E' })
      setTimeout(() => void restoreQueueBadge(), 2000)
    } else if (res.error !== 'queued') {
      // A queued save already set its own count badge inside captureOrQueue.
      await flashErrorBadge()
    }
  })

  // Restore the badge + retry alarm whenever the service worker (re)starts.
  void (async () => {
    const queue = await readQueue()
    await setBadge(queue.length)
    if (queue.length > 0) await ensureFlushAlarm()
  })()
})
