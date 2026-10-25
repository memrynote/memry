/**
 * Recording + fault-injecting HTTP proxy in front of the simulated sync server.
 *
 * The E2E "simulated server" is the real Worker running in Miniflare, and the
 * Electron app talks to it over a real socket. That leaves the test process no
 * way to observe what the client actually asked for, nor to interrupt a
 * transfer the way a flaky network does. This proxy sits between them:
 *
 *   Electron  ->  this proxy  ->  Miniflare (real Worker)
 *
 *  - RECORDS every request as `{ method, path, status }`. Only the pathname is
 *    kept, never the query string: presigned URLs and tokens are credentials
 *    and must not reach a log, an assertion message or a trace.
 *  - INJECTS faults: cut the response socket after N bytes so the client sees a
 *    transport failure mid-body — the exact shape a resumable download has to
 *    survive — delay a request, or answer it with a chosen status instead.
 *
 * node:http rather than fetch on purpose: it streams both directions without
 * buffering (a push body or a pack download can be large) and it hands us the
 * socket, which is what "interrupt mid-transfer" needs.
 */

import http from 'node:http'
import net, { type AddressInfo } from 'node:net'

export interface ProxyRequestRecord {
  method: string
  /** Pathname only — the query string can carry credentials. */
  path: string
  /** Upstream status, or 0 when the fault cut the response before it landed. */
  status: number
  at: number
  /** True when a fault rule severed this response. */
  severed: boolean
  /** Milliseconds a fault rule held the request before forwarding it; 0 when none did. */
  delayedMs: number
  /** True when a fault rule answered with its own status and the upstream never saw the call. */
  overridden: boolean
  /**
   * `device_id` claim of the bearer token, or null for unauthenticated calls.
   * Lets a two-device spec attribute each request to the device that sent it.
   */
  deviceId: string | null
}

/**
 * Reads the `device_id` claim out of a bearer JWT without verifying it: the
 * proxy only labels traffic, the Worker behind it does the real check. Only the
 * claim is kept, never the token.
 */
function bearerDeviceId(authorization: string | undefined): string | null {
  const payload = authorization?.match(/^Bearer\s+[^.]+\.([^.]+)\./)?.[1]
  if (!payload) return null
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      device_id?: unknown
    }
    return typeof claims.device_id === 'string' ? claims.device_id : null
  } catch {
    return null
  }
}

export interface FaultRule {
  /** Matches on method + pathname (no query string). */
  match: (method: string, pathname: string) => boolean
  /**
   * Sever the socket once this many response-body bytes have been forwarded.
   * 0 severs before any body byte reaches the client. Omit to leave the body alone.
   */
  afterBytes?: number
  /** Hold the request this long before forwarding it. */
  delayMs?: number
  /** Answer with this status and an empty body; the upstream is not called. */
  status?: number
  /** Stop injecting after this many matching requests have been hit. */
  maxHits: number
}

export interface SyncProxy {
  /** Base URL the app should be pointed at. */
  url: string
  /** Every request seen so far, oldest first. */
  records: ProxyRequestRecord[]
  requests(filter?: { method?: string; pathPrefix?: string }): ProxyRequestRecord[]
  countStatus(status: number, pathPrefix?: string): number
  /** Install a fault rule. Replaces any rule installed before it. */
  injectFault(rule: FaultRule): void
  clearFaults(): void
  /** Number of responses severed since the last `clearFaults`. */
  faultHits(): number
  close(): Promise<void>
}

export async function startSyncProxy(
  targetUrl: string,
  options: { forwardWebSocket?: boolean } = {}
): Promise<SyncProxy> {
  const target = new URL(targetUrl)
  const records: ProxyRequestRecord[] = []
  let fault: FaultRule | null = null
  let hits = 0

  const server = http.createServer((req, res) => {
    const rawUrl = req.url ?? '/'
    const pathname = rawUrl.split('?')[0]
    const method = req.method ?? 'GET'
    const record: ProxyRequestRecord = {
      method,
      path: pathname,
      status: 0,
      at: Date.now(),
      severed: false,
      delayedMs: 0,
      overridden: false,
      deviceId: bearerDeviceId(req.headers.authorization)
    }
    records.push(record)

    const rule =
      fault !== null && hits < fault.maxHits && fault.match(method, pathname) ? fault : null
    if (rule) hits += 1
    const severing = rule?.afterBytes !== undefined

    if (rule?.status !== undefined) {
      record.status = rule.status
      record.overridden = true
      req.resume()
      res.writeHead(rule.status)
      res.end()
      return
    }

    const upstream = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: rawUrl,
        method,
        headers: { ...req.headers, host: target.host }
      },
      (upstreamRes) => {
        record.status = upstreamRes.statusCode ?? 0

        if (!severing) {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
          upstreamRes.pipe(res)
          return
        }

        record.severed = true
        const budget = rule.afterBytes ?? 0
        // No content-length is forwarded on a severed response: the point is a
        // transport failure, and an honest length would only invite the client
        // to treat the truncated body as complete.
        const headers = { ...upstreamRes.headers }
        delete headers['content-length']
        res.writeHead(upstreamRes.statusCode ?? 502, headers)

        let sent = 0
        upstreamRes.on('data', (chunk: Buffer) => {
          if (sent >= budget) return
          const room = budget - sent
          const slice = chunk.length <= room ? chunk : chunk.subarray(0, room)
          sent += slice.length
          res.write(slice)
          if (sent >= budget) {
            upstreamRes.destroy()
            res.destroy()
          }
        })
        upstreamRes.on('end', () => {
          // Body was shorter than the budget — sever anyway, otherwise the
          // "interrupted" transfer would quietly succeed.
          res.destroy()
        })
      }
    )

    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.destroy()
    })
    req.on('error', () => upstream.destroy())
    if (rule?.delayMs) {
      record.delayedMs = rule.delayMs
      setTimeout(() => req.pipe(upstream), rule.delayMs)
    } else {
      req.pipe(upstream)
    }
  })

  // Opt-in: a WebSocket upgrade (`/sync/ws`) is forwarded as raw bytes, never
  // inspected. Without it a proxied device never receives a `changes_available`
  // wake and only pulls when told to. Recorded with status 101.
  const tunnels = new Set<net.Socket>()
  server.on('upgrade', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    if (!options.forwardWebSocket) {
      socket.destroy()
      return
    }
    const rawUrl = req.url ?? '/'
    records.push({
      method: req.method ?? 'GET',
      path: rawUrl.split('?')[0],
      status: 101,
      at: Date.now(),
      severed: false,
      delayedMs: 0,
      overridden: false,
      deviceId: bearerDeviceId(req.headers.authorization)
    })
    const upstream = net.connect(Number(target.port), target.hostname, () => {
      const lines = [`${req.method} ${rawUrl} HTTP/${req.httpVersion}`]
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i]
        lines.push(
          `${name}: ${name.toLowerCase() === 'host' ? target.host : req.rawHeaders[i + 1]}`
        )
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    for (const end of [socket, upstream]) {
      tunnels.add(end)
      end.on('close', () => tunnels.delete(end))
    }
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}`,
    records,
    requests(filter) {
      return records.filter((entry) => {
        if (filter?.method && entry.method !== filter.method) return false
        if (filter?.pathPrefix && !entry.path.startsWith(filter.pathPrefix)) return false
        return true
      })
    },
    countStatus(status, pathPrefix) {
      return records.filter(
        (entry) => entry.status === status && (!pathPrefix || entry.path.startsWith(pathPrefix))
      ).length
    },
    injectFault(rule) {
      fault = rule
      hits = 0
    },
    clearFaults() {
      fault = null
      hits = 0
    },
    faultHits() {
      return hits
    },
    async close() {
      await new Promise<void>((resolve) => {
        for (const socket of tunnels) socket.destroy()
        server.closeAllConnections?.()
        server.close(() => resolve())
      })
    }
  }
}
