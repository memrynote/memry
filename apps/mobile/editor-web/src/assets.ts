import type { GuestBridge } from './bridge.ts'

/**
 * `asset-req` / `asset` round trips (T072 web half).
 *
 * The WebView cannot read the vault sandbox, so every image and attachment
 * reference is resolved by asking RN.
 *
 * Answers are cached per REF, and only when they RESOLVED. A `pending` answer
 * is deliberately not cached: "not downloaded yet" is normal under the
 * Wi-Fi-only default and it changes on its own, so caching it would freeze the
 * placeholder for the life of the page. `images.ts` owns the re-asking.
 */

/** What the host said, not just whether bytes arrived. */
export type AssetAnswer =
  { status: 'ready'; dataUri: string } | { status: 'pending' } | { status: 'missing' }

interface PendingAsset {
  resolve: (answer: AssetAnswer) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * How long to wait for an `asset` reply.
 *
 * A reply can genuinely never come — a resync clears the host's pending batch
 * — and without a deadline that image stays on its placeholder forever and the
 * map entry leaks for the life of the page.
 */
const ASSET_REPLY_TIMEOUT_MS = 20_000

let bridge: GuestBridge | null = null
let nextReqId = 0
const pending = new Map<string, PendingAsset>()
const cache = new Map<string, string>()

export function bindAssetBridge(instance: GuestBridge): void {
  bridge = instance
  instance.onHostMsg((msg) => {
    if (msg.type !== 'asset') return
    const waiter = pending.get(msg.reqId)
    if (!waiter) return
    pending.delete(msg.reqId)
    clearTimeout(waiter.timer)

    if (msg.status !== 'ready') {
      waiter.resolve({ status: msg.status === 'missing' ? 'missing' : 'pending' })
      return
    }
    const dataUri =
      msg.url ??
      (msg.b64 ? `data:${msg.mime ?? 'application/octet-stream'};base64,${msg.b64}` : null)
    waiter.resolve(dataUri ? { status: 'ready', dataUri } : { status: 'missing' })
  })
}

export function requestAsset(ref: string): Promise<AssetAnswer> {
  const cached = cache.get(ref)
  if (cached) return Promise.resolve({ status: 'ready', dataUri: cached })
  // No bridge means the page is not wired up yet, which is a transient state —
  // reporting `missing` would retire the image permanently.
  if (!bridge) return Promise.resolve({ status: 'pending' })

  const reqId = `a${++nextReqId}`
  return new Promise<AssetAnswer>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(reqId)
      resolve({ status: 'pending' })
    }, ASSET_REPLY_TIMEOUT_MS)

    pending.set(reqId, {
      timer,
      resolve: (answer) => {
        if (answer.status === 'ready') cache.set(ref, answer.dataUri)
        resolve(answer)
      }
    })
    bridge!.send({ type: 'asset-req', reqId, ref })
  })
}
