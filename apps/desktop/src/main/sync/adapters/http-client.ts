import type { SyncHttpClient, SyncHttpRequest, SyncHttpResponse } from '@memry/sync-client/adapters'

/**
 * Desktop implementation of seam 1 — plain fetch against the sync base URL.
 *
 * Auth headers and `x-memry-client` belong to the engine (the seam forbids the
 * adapter from inventing headers); today's `syncFetch` machinery keeps carrying
 * them until the engine drives requests through this seam. The online signal
 * is desktop's real `NetworkMonitor` (injected as a source so the adapter is
 * constructible under node); metering is a documented constant — desktop
 * platforms expose no metered-connection signal Memry can read, so the
 * Wi-Fi-only attachment policy never throttles on desktop, which is today's
 * behaviour.
 */
export interface OnlineSignalSource {
  onStatusChanged(cb: (online: boolean) => void): () => void
}

export interface DesktopSyncHttpClientDeps {
  baseUrl(): string
  online: OnlineSignalSource
}

export class DesktopSyncHttpClient implements SyncHttpClient {
  constructor(private readonly deps: DesktopSyncHttpClientDeps) {}

  async request(req: SyncHttpRequest): Promise<SyncHttpResponse> {
    const base = this.deps.baseUrl().replace(/\/$/, '')
    const url = `${base}${req.path.startsWith('/') ? '' : '/'}${req.path}`
    const body =
      req.body === undefined
        ? undefined
        : typeof req.body === 'string'
          ? req.body
          : // Copy into a plain ArrayBuffer-backed view so SharedArrayBuffer-typed
            // unions never reach fetch's BodyInit.
            new Uint8Array(req.body).slice()
    const response = await fetch(url, {
      method: req.method,
      headers: req.headers,
      body,
      signal: req.signal
    })
    const headers: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      headers[key] = value
    })
    return {
      status: response.status,
      headers,
      body: new Uint8Array(await response.arrayBuffer())
    }
  }

  onOnlineChanged(cb: (online: boolean) => void): () => void {
    return this.deps.online.onStatusChanged(cb)
  }

  async isMetered(): Promise<boolean> {
    return false
  }
}
