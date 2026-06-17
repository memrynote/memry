import type { ArticleCapture } from '@memry/article-extract'

export const DEFAULT_PORT = 7849
export const PROBE_RANGE = 8
export const PROBE_PORTS = Array.from({ length: PROBE_RANGE }, (_, i) => DEFAULT_PORT + i)

const CAPTURE_HEADER = 'X-Memry-Capture'

export function pingUrl(port: number): string {
  return `http://127.0.0.1:${port}/ping`
}
export function claimUrl(port: number): string {
  return `http://127.0.0.1:${port}/pair/claim`
}
export function pairRequestUrl(port: number): string {
  return `http://127.0.0.1:${port}/pair/request`
}
export function captureUrl(port: number): string {
  return `http://127.0.0.1:${port}/capture`
}
export function revokeUrl(port: number): string {
  return `http://127.0.0.1:${port}/pair/revoke`
}

export interface PingResponse {
  app: 'memry'
  version: string
  paired: boolean
}

export function parsePing(data: unknown): PingResponse | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (d.app !== 'memry' || typeof d.paired !== 'boolean') return null
  return { app: 'memry', version: String(d.version ?? ''), paired: d.paired }
}

// Probe the loopback range. Returns the first live memry server, or null.
export async function probeServer(
  fetchFn: typeof fetch = fetch,
  ports: number[] = PROBE_PORTS
): Promise<{ port: number; ping: PingResponse } | null> {
  for (const port of ports) {
    try {
      const res = await fetchFn(pingUrl(port), { method: 'GET' })
      if (!res.ok) continue
      const ping = parsePing(await res.json())
      if (ping) return { port, ping }
    } catch {
      // port not listening — try the next one
    }
  }
  return null
}

// POST /pair/claim. The X-Memry-Capture header is required; Origin is attached
// by Chrome automatically. Returns the token on 200, null on 400/403/etc.
export async function claimToken(
  port: number,
  fetchFn: typeof fetch = fetch
): Promise<string | null> {
  try {
    const res = await fetchFn(claimUrl(port), {
      method: 'POST',
      headers: { [CAPTURE_HEADER]: '1' }
    })
    if (!res.ok) return null
    const data = (await res.json()) as { token?: unknown }
    return typeof data.token === 'string' ? data.token : null
  } catch {
    return null
  }
}

// Ask the desktop app to pair this extension. 200 = origin already allowlisted (a
// pairing window was opened so we can re-claim the token); 202 = the desktop is
// showing an Allow/Deny dialog; error = unreachable/declined-shaped response.
export async function requestPair(
  port: number,
  fetchFn: typeof fetch = fetch
): Promise<'already-paired' | 'pending' | 'error'> {
  try {
    const res = await fetchFn(pairRequestUrl(port), {
      method: 'POST',
      headers: { [CAPTURE_HEADER]: '1' }
    })
    if (res.status === 200) return 'already-paired'
    if (res.status === 202) return 'pending'
    return 'error'
  } catch {
    return 'error'
  }
}

export function captureHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    [CAPTURE_HEADER]: '1'
  }
}

export async function postRevoke(
  port: number,
  token: string,
  fetchFn: typeof fetch = fetch
): Promise<boolean> {
  try {
    const res = await fetchFn(revokeUrl(port), { method: 'POST', headers: captureHeaders(token) })
    return res.ok
  } catch {
    return false
  }
}

export async function postCapture(
  port: number,
  token: string,
  capture: ArticleCapture,
  fetchFn: typeof fetch = fetch
): Promise<{ ok: true; itemId: string } | { ok: false; error: string }> {
  try {
    const res = await fetchFn(captureUrl(port), {
      method: 'POST',
      headers: captureHeaders(token),
      body: JSON.stringify(capture)
    })
    if (res.ok) {
      const data = (await res.json()) as { itemId?: unknown }
      return { ok: true, itemId: String(data.itemId ?? '') }
    }
    const data = (await res.json().catch(() => ({}))) as { error?: unknown }
    return { ok: false, error: typeof data.error === 'string' ? data.error : `http-${res.status}` }
  } catch {
    return { ok: false, error: 'network' }
  }
}

// Call `attempt` until it returns a non-null value or the deadline passes.
export async function pollUntil<T>(
  attempt: () => Promise<T | null>,
  opts: {
    intervalMs: number
    timeoutMs: number
    sleep?: (ms: number) => Promise<void>
    now?: () => number
  }
): Promise<T | null> {
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const now = opts.now ?? (() => Date.now())
  const deadline = now() + opts.timeoutMs
  for (;;) {
    const result = await attempt()
    if (result !== null) return result
    if (now() >= deadline) return null
    await sleep(opts.intervalMs)
  }
}
