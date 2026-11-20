// The shell-agnostic half of the bootstrap benchmark (#5223): every shell hands
// in the proxy's request log and three marks, and gets back the same metrics.

// The Worker's parameterised routes; every other path is already an endpoint.
const ROUTE_PARAMS = [
  [/^\/sync\/crdt\/snapshot\/(?!batch$)[^/]+$/, '/sync/crdt/snapshot/:id'],
  [/^\/sync\/items\/[^/]+$/, '/sync/items/:id'],
  [/^\/sync\/blob\/[^/]+$/, '/sync/blob/:id'],
  [/^\/sync\/attachments\/chunks\/[^/]+$/, '/sync/attachments/chunks/:id'],
  [
    /^\/sync\/attachments\/upload\/(?!initiate$)[^/]+(\/complete)?$/,
    '/sync/attachments/upload/:id$1'
  ],
  [/^\/sync\/attachments\/[^/]+\/manifest$/, '/sync/attachments/:id/manifest'],
  [/^\/devices\/[^/]+$/, '/devices/:id']
]

/** `/sync/crdt/snapshot/abc?x=1` -> `GET /sync/crdt/snapshot/:id`. */
export function endpointOf(request) {
  if (request.host === 'r2') return `${request.method} r2:pack`
  const pathname = request.path.split('?')[0]
  for (const [pattern, route] of ROUTE_PARAMS) {
    if (pattern.test(pathname)) return `${request.method} ${pathname.replace(pattern, route)}`
  }
  return `${request.method} ${pathname}`
}

export function channelOf(request) {
  const pathname = request.path.split('?')[0]
  if (request.host === 'r2' || pathname.endsWith('/packs')) return 'packs'
  if (/^\/sync\/(attachments|blob)\b/.test(pathname)) return 'attachments'
  if (pathname.includes('/crdt/snapshot')) return 'snapshots'
  if (pathname.includes('/crdt/')) return 'updates'
  if (/\/sync\/(changes|pull|manifest|items)\b/.test(pathname)) return 'records'
  return 'other'
}

/** A `GET /sync/changes` that starts the feed from the beginning. */
function readsFromZero(request) {
  if (request.method !== 'GET' || !request.path.startsWith('/sync/changes')) return false
  const cursor = new URL(request.path, 'http://x').searchParams.get('cursor')
  return cursor === null || cursor === '0'
}

/** Milliseconds during which at least one request was in flight. */
export function busyMs(requests) {
  const spans = requests
    .filter((r) => r.method !== 'WS')
    .map((r) => [r.startMs, r.endMs])
    .toSorted((a, b) => a[0] - b[0])
  let total = 0
  let current = null
  for (const [start, end] of spans) {
    if (!current || start > current[1]) {
      if (current) total += current[1] - current[0]
      current = [start, end]
    } else {
      current[1] = Math.max(current[1], end)
    }
  }
  if (current) total += current[1] - current[0]
  return total
}

/** The most requests in flight at once; an end at the same ms frees its slot first. */
export function maxInFlight(requests) {
  const edges = requests
    .flatMap((r) => [
      [r.startMs, 1],
      [r.endMs, -1]
    ])
    .toSorted((a, b) => a[0] - b[0] || a[1] - b[1])
  let current = 0
  let max = 0
  for (const [, step] of edges) {
    current += step
    max = Math.max(max, current)
  }
  return max
}

function median(values) {
  if (values.length === 0) return null
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/**
 * What bounded the run. The network is idle while the client applies,
 * decrypts or paces itself. `pacedMs` is the time the client said it slept
 * (core marks each wait; null when the shell cannot tell), so the rest of the
 * idle time is local work. When the network is mostly busy, the throughput
 * while busy against the line measured at the start says whether the line or
 * the request count was the ceiling.
 */
export function limiterOf({ wallMs, busy, pacedMs = null, bytes, requests, lineMbps }) {
  if (wallMs <= 0 || requests === 0) return { kind: 'unknown', why: 'no requests in the window' }
  const idleMs = Math.max(0, wallMs - busy)
  const idleShare = idleMs / wallMs
  const busyMbps = busy > 0 ? (bytes * 8) / 1e6 / (busy / 1000) : 0
  const paced = pacedMs === null ? '' : `, ${(pacedMs / 1000).toFixed(1)} s of it client sleeps`
  const facts = `network idle ${Math.round(idleShare * 100)}% of ${(wallMs / 1000).toFixed(1)} s${paced}, ${busyMbps.toFixed(1)} of ${lineMbps.toFixed(1)} Mbit/s while busy, ${requests} requests`
  if (idleShare >= 0.5) {
    if (pacedMs === null) return { kind: 'local apply or client pacing', why: facts }
    return { kind: pacedMs >= idleMs - pacedMs ? 'client pacing' : 'local apply', why: facts }
  }
  if (busyMbps >= lineMbps * 0.5) return { kind: 'line speed', why: facts }
  return { kind: 'request latency × count', why: facts }
}

/**
 * `marks`: `startMs` (bootstrap requested), `recordsMs` (every record
 * applied), `bodiesMs` (every live body local; null when not reached).
 * `sleeps`: `[startMs, ms]` waits the client marked, or null when the shell
 * does not mark them. `lineMbps`: the line measured at the start of the run.
 */
export function summarize({ requests, marks, sleeps = null, staleLockReleases = 0, lineMbps }) {
  const { startMs, recordsMs = null, bodiesMs = null } = marks
  const endMs = bodiesMs ?? Math.max(startMs, ...requests.map((r) => r.endMs))
  const inWindow = requests.filter((r) => r.startMs >= startMs && r.startMs <= endMs)
  // A refused write never reached the server: counted apart, not as traffic.
  const counted = inWindow.filter((r) => r.method !== 'WS' && !r.refused)
  const pacedMs =
    sleeps === null
      ? null
      : sleeps
          .map(([at, ms]) => Math.min(at + ms, endMs) - Math.max(at, startMs))
          .reduce((total, ms) => total + Math.max(0, ms), 0)

  const endpoints = {}
  const bytes = { records: 0, packs: 0, snapshots: 0, updates: 0, attachments: 0, other: 0 }
  for (const request of counted) {
    const key = endpointOf(request)
    const row = (endpoints[key] ??= { count: 0, bytes: 0, durations: [], requests: [] })
    row.count += 1
    row.bytes += request.resBytes
    row.durations.push(request.endMs - request.startMs)
    row.requests.push(request)
    bytes[channelOf(request)] += request.resBytes
  }
  const byEndpoint = Object.fromEntries(
    Object.entries(endpoints)
      .toSorted((a, b) => b[1].count - a[1].count)
      .map(([key, row]) => [
        key,
        {
          count: row.count,
          bytes: row.bytes,
          p50Ms: median(row.durations),
          maxInFlight: maxInFlight(row.requests)
        }
      ])
  )

  const totalBytes = Object.values(bytes).reduce((a, b) => a + b, 0)
  const busy = busyMs(counted)
  const zeroReads = counted.filter(readsFromZero).length
  return {
    tRecordsMs: recordsMs === null ? null : recordsMs - startMs,
    tBodiesMs: bodiesMs === null ? null : bodiesMs - startMs,
    requests: {
      total: counted.length,
      worker: counted.filter((r) => r.host === 'worker').length,
      r2: counted.filter((r) => r.host === 'r2').length,
      maxInFlight: maxInFlight(counted),
      writesRefused: inWindow.filter((r) => r.refused).length,
      byEndpoint
    },
    lineMbps,
    bytes: { ...bytes, total: totalBytes },
    disruptions: {
      http429: counted.filter((r) => r.status === 429).length,
      restartsFromZero: Math.max(0, zeroReads - 1),
      staleLockReleases,
      transportErrors: counted.filter((r) => r.error).length
    },
    limiter: limiterOf({
      wallMs: endMs - startMs,
      busy,
      pacedMs,
      bytes: totalBytes,
      requests: counted.length,
      lineMbps
    })
  }
}

const seconds = (ms) => (ms === null ? 'not reached' : `${(ms / 1000).toFixed(1)} s`)
const megabytes = (n) => `${(n / 1e6).toFixed(2)} MB`

export function formatReport(label, metrics) {
  const lines = [
    `### ${label}`,
    '',
    '| Metric | Value |',
    '|---|---|',
    `| t_records | ${seconds(metrics.tRecordsMs)} |`,
    `| t_bodies | ${seconds(metrics.tBodiesMs)} |`,
    `| Requests | ${metrics.requests.total} (Worker ${metrics.requests.worker}, R2 ${metrics.requests.r2}), at most ${metrics.requests.maxInFlight} in flight |`,
    `| Writes refused | ${metrics.requests.writesRefused} |`,
    `| Bytes | records ${megabytes(metrics.bytes.records)}, packs ${megabytes(metrics.bytes.packs)}, snapshots ${megabytes(metrics.bytes.snapshots)}, updates ${megabytes(metrics.bytes.updates)}, other ${megabytes(metrics.bytes.other)} |`,
    `| Attachments | ${
      metrics.bytes.attachments === 0
        ? '0 bytes (out of scope)'
        : `${megabytes(metrics.bytes.attachments)}: NOT ZERO, presigned attachment downloads bypass the proxy, so this run's counts are incomplete`
    } |`,
    `| Line | ${metrics.lineMbps.toFixed(1)} Mbit/s, measured at the start |`,
    `| Disruptions | 429: ${metrics.disruptions.http429}, restarts from cursor 0: ${metrics.disruptions.restartsFromZero}, stale-lock releases: ${metrics.disruptions.staleLockReleases}, transport errors: ${metrics.disruptions.transportErrors} |`,
    `| Limiter | ${metrics.limiter.kind} (${metrics.limiter.why}) |`,
    '',
    '| Endpoint | Requests | Bytes | p50 | Max in flight |',
    '|---|---|---|---|---|'
  ]
  for (const [endpoint, row] of Object.entries(metrics.requests.byEndpoint)) {
    lines.push(
      `| \`${endpoint}\` | ${row.count} | ${megabytes(row.bytes)} | ${row.p50Ms} ms | ${row.maxInFlight} |`
    )
  }
  return `${lines.join('\n')}\n`
}
