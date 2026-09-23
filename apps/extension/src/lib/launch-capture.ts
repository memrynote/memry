import type { ArticleCapture } from '@memry/article-extract'
import { isQueueable, isRetryable, queuedError } from './capture-queue'
import type { CaptureResponse, PairResponse } from './messages'

export interface LaunchCaptureDeps {
  enqueue: (capture: ArticleCapture) => Promise<string>
  openApp: () => Promise<void>
  waitForServer: () => Promise<boolean>
  ensurePaired: () => Promise<PairResponse>
  deliverQueued: (id: string) => Promise<CaptureResponse>
  send: (capture: ArticleCapture) => Promise<CaptureResponse>
}

// Runs in the background, never in the popup: opening memry:// moves focus to a
// new tab or to the app, and the browser closes the popup along with any draft it
// still holds. So the capture is persisted before focus leaves.
export async function launchAndCapture(
  capture: ArticleCapture,
  deps: LaunchCaptureDeps
): Promise<CaptureResponse> {
  const queuedId = isQueueable(capture) ? await deps.enqueue(capture) : null
  await deps.openApp()
  if (!(await deps.waitForServer())) {
    return { ok: false, error: queuedId ? 'queued' : 'app-closed' }
  }
  const paired = await deps.ensurePaired()
  if (!paired.ok) return paired
  if (!queuedId) return deps.send(capture)
  const res = await deps.deliverQueued(queuedId)
  return res.ok || !isRetryable(res.error) ? res : { ok: false, error: queuedError(res.error) }
}
