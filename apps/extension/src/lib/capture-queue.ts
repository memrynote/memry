import type { ArticleCapture } from '@memry/article-extract'
import type { CaptureResponse } from './messages'

export interface QueuedCapture {
  id: string
  capture: ArticleCapture
  queuedAt: number
}

export const MAX_QUEUE = 50

// Retryable = the server was unreachable or had no vault open, not the payload
// being bad. Pairing, validation, 4xx and other 5xx codes are permanent: retrying
// never helps and a 5xx loop would spin forever on a server bug. ponytail: upgrade
// path = backoff-retry 5xx a few times before dropping.
export function isRetryable(error: string): boolean {
  return error === 'app-closed' || error === 'network' || error === 'vault-closed'
}

// The popup-facing code for a capture that stays queued after a retryable error.
export function queuedError(retryableError: string): 'queued' | 'queued-vault-closed' {
  return retryableError === 'vault-closed' ? 'queued-vault-closed' : 'queued'
}

export interface DrainResult {
  outcomes: Map<string, CaptureResponse>
  // Delivered or permanently rejected: these leave the queue.
  settled: Set<string>
}

// Post oldest-first. The first retryable failure stops the pass, and every item
// not yet posted keeps that same outcome.
export async function drainQueue(
  queue: QueuedCapture[],
  post: (capture: ArticleCapture) => Promise<CaptureResponse>
): Promise<DrainResult> {
  const outcomes = new Map<string, CaptureResponse>()
  const settled = new Set<string>()
  let stoppedOn: CaptureResponse | null = null
  for (const item of queue) {
    const res: CaptureResponse = stoppedOn ?? (await post(item.capture))
    outcomes.set(item.id, res)
    if (res.ok || !isRetryable(res.error)) settled.add(item.id)
    else stoppedOn = res
  }
  return { outcomes, settled }
}

// Append, dropping the oldest when the queue would exceed `max`.
export function enqueue(
  queue: QueuedCapture[],
  item: QueuedCapture,
  max = MAX_QUEUE
): QueuedCapture[] {
  const next = [...queue, item]
  return next.length > max ? next.slice(next.length - max) : next
}

export function badgeText(count: number): string {
  if (count <= 0) return ''
  return count > 99 ? '99+' : String(count)
}

// PDF captures carry megabytes of base64 and are never queued: Chrome caps
// storage.local at 10MB without the unlimitedStorage permission. The popup's
// launch-and-send flow already covers the app-closed case, and the tab is still
// open, so retrying is one click.
export function isQueueable(capture: ArticleCapture): boolean {
  return !capture.pdfDataUrl
}
