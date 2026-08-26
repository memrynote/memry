import { DurableObject } from 'cloudflare:workers'

interface WindowState {
  count: number
  windowStart: number
}

export interface ConsumeRequest {
  windowSeconds: number
}

export interface ConsumeResponse {
  count: number
  windowStart: number
}

/**
 * Fixed-window request counter, one instance per rate-limit key
 * (`${keyPrefix}:${identifier}` — see src/middleware/rate-limit.ts).
 *
 * Replaces the D1 `rate_limits` upsert with the same semantics: a request
 * starts a new window when the stored one is older than `windowSeconds`,
 * otherwise it increments the running count. The count keeps growing past the
 * ceiling — the middleware compares it against the bucket's limit, which keeps
 * limit changes (and P1.2 bootstrap-session elevation) out of the counter.
 *
 * The Workers rate-limiting binding was rejected on purpose: it only supports
 * 10s/60s periods (six buckets run 300–3600s windows), one static limit per
 * named binding (29 buckets = 29 bindings), and exposes no window state for an
 * exact Retry-After.
 */
export class RateLimiter extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== '/consume') {
      return new Response('Not found', { status: 404 })
    }

    const body: ConsumeRequest = await request.json()
    const windowSeconds = body.windowSeconds
    const now = Math.floor(Date.now() / 1000)

    const existing = (await this.ctx.storage.get<WindowState>('window')) ?? null
    let state: WindowState
    if (!existing || existing.windowStart < now - windowSeconds) {
      state = { count: 1, windowStart: now }
      // Hygiene: clear storage once the window has fully lapsed so an idle key
      // costs nothing. The +1s slack means the alarm only ever deletes a
      // window that the reset condition above would discard anyway.
      await this.ctx.storage.setAlarm((now + windowSeconds + 1) * 1000)
    } else {
      state = { count: existing.count + 1, windowStart: existing.windowStart }
    }
    await this.ctx.storage.put('window', state)

    const response: ConsumeResponse = { count: state.count, windowStart: state.windowStart }
    return Response.json(response)
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll()
  }
}
