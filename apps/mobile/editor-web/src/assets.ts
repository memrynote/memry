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

interface PendingAsset {
  resolve: (value: string | null) => void
}

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
    const value =
      msg.url ??
      (msg.b64 ? `data:${msg.mime ?? 'application/octet-stream'};base64,${msg.b64}` : null)
    waiter.resolve(msg.status === 'ready' ? value : null)
  })
}

export function requestAsset(ref: string): Promise<string | null> {
  const cached = cache.get(ref)
  if (cached) return Promise.resolve(cached)
  if (!bridge) return Promise.resolve(null)

  const reqId = `a${++nextReqId}`
  return new Promise<string | null>((resolve) => {
    pending.set(reqId, {
      resolve: (value) => {
        if (value) cache.set(ref, value)
        resolve(value)
      }
    })
    bridge!.send({ type: 'asset-req', reqId, ref })
  })
}
