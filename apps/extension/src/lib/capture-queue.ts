import type { ArticleCapture } from '@memry/article-extract'

export interface QueuedCapture {
  id: string
  capture: ArticleCapture
  queuedAt: number
}

export const MAX_QUEUE = 50

// Retryable = the server was unreachable, not the payload being bad. Pairing,
// validation, 4xx and 5xx codes are permanent — retrying never helps and a 5xx
// loop would spin forever on a server bug. ponytail: upgrade path = backoff-retry
// 5xx a few times before dropping.
export function isRetryable(error: string): boolean {
  return error === 'app-closed' || error === 'network'
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

export function dequeueById(queue: QueuedCapture[], id: string): QueuedCapture[] {
  return queue.filter((q) => q.id !== id)
}

export function badgeText(count: number): string {
  if (count <= 0) return ''
  return count > 99 ? '99+' : String(count)
}
