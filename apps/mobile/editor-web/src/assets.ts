import type { GuestBridge } from './bridge.ts'

/**
 * `asset-req` / `asset` round trips (T072 web half).
 *
 * The WebView cannot read the vault sandbox, so every image and attachment ref
 * is resolved by asking RN. Answers are cached per `ref@revision`: a late
 * download bumps the revision, which is what makes the picture appear without
 * recreating the note — the old cache entry is simply never asked for again.
 */

interface PendingAsset {
  resolve: (value: string | null) => void
}

let bridge: GuestBridge | null = null
let nextReqId = 0
const pending = new Map<string, PendingAsset>()
const cache = new Map<string, string>()
/** refs whose element must be re-resolved once a newer revision arrives. */
const refRevision = new Map<string, number>()
const watchers = new Set<(ref: string) => void>()

export function bindAssetBridge(instance: GuestBridge): void {
  bridge = instance
  instance.onHostMsg((msg) => {
    if (msg.type !== 'asset') return
    const waiter = pending.get(msg.reqId)
    pending.delete(msg.reqId)
    const value =
      msg.url ??
      (msg.b64 ? `data:${msg.mime ?? 'application/octet-stream'};base64,${msg.b64}` : null)
    if (waiter) waiter.resolve(msg.status === 'ready' ? value : null)
  })
}

/** Called by RN through `assetRevisionBumped` when a lazy download completes. */
export function invalidateAsset(ref: string): void {
  const next = (refRevision.get(ref) ?? 0) + 1
  refRevision.set(ref, next)
  cache.delete(ref)
  for (const watcher of watchers) watcher(ref)
}

export function onAssetInvalidated(watcher: (ref: string) => void): () => void {
  watchers.add(watcher)
  return () => watchers.delete(watcher)
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
