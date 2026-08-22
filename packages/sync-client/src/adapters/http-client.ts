/** Seam 1 — transport. Replaces desktop's `http-client.ts` + `network.ts`. */

export type SyncHttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export interface SyncHttpRequest {
  method: SyncHttpMethod
  /** Relative to the sync base URL. */
  path: string
  /** The engine adds `x-memry-client` here; adapters must not invent headers. */
  headers?: Record<string, string>
  body?: Uint8Array | string
  signal?: AbortSignal
}

export interface SyncHttpResponse {
  status: number
  headers: Record<string, string>
  body: Uint8Array
}

export interface SyncHttpClient {
  request(req: SyncHttpRequest): Promise<SyncHttpResponse>
  /**
   * Connectivity signal for outbox pacing. Push-based, and returns its own
   * unsubscribe — the engine has no platform teardown hook to hang it on.
   */
  onOnlineChanged(cb: (online: boolean) => void): () => void
  /** Drives the attachments Wi-Fi-only policy, which lives in the engine. */
  isMetered(): Promise<boolean>
}
