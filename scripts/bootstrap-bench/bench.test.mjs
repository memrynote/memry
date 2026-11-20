import assert from 'node:assert/strict'
import http from 'node:http'
import { describe, it } from 'node:test'

import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { electronMarks, followLog, parseMainLog } from './electron-log.mjs'
import { busyMs, endpointOf, formatReport, limiterOf, maxInFlight, summarize } from './metrics.mjs'
import { assertAllowedUpstream, startProxy } from './proxy.mjs'
import { bodyDebt, findBootstrapDb, feedHeadMs, iosMarks, tauriStartMs } from './rust-shell.mjs'

const request = (fields) => ({
  method: 'GET',
  host: 'worker',
  status: 200,
  reqBytes: 0,
  resBytes: 100,
  ...fields
})

describe('summarize', () => {
  it('counts only the window from start to every body local', () => {
    const metrics = summarize({
      marks: { startMs: 1_000, recordsMs: 3_000, bodiesMs: 5_000 },
      lineMbps: 100,
      requests: [
        request({ path: '/auth/otp/verify', startMs: 500, endMs: 600 }),
        request({ path: '/sync/changes?limit=500', startMs: 1_000, endMs: 1_200 }),
        request({ path: '/sync/changes?limit=500&cursor=40', startMs: 1_300, endMs: 1_400 }),
        request({ path: '/sync/changes?limit=500&cursor=0', startMs: 1_500, endMs: 1_600 }),
        request({
          path: '/sync/crdt/snapshot/note1234567890',
          startMs: 2_000,
          endMs: 2_300,
          status: 429
        }),
        request({ path: '/sync/crdt/snapshot/note0987654321', startMs: 2_100, endMs: 2_200 }),
        request({ host: 'r2', path: '/p?sig=x', startMs: 3_000, endMs: 3_100, resBytes: 5_000 }),
        request({ path: '/sync/changes?limit=500', startMs: 6_000, endMs: 6_100 })
      ]
    })
    assert.equal(metrics.tRecordsMs, 2_000)
    assert.equal(metrics.tBodiesMs, 4_000)
    assert.deepEqual(
      { total: metrics.requests.total, worker: metrics.requests.worker, r2: metrics.requests.r2 },
      { total: 6, worker: 5, r2: 1 }
    )
    assert.equal(metrics.requests.byEndpoint['GET /sync/crdt/snapshot/:id'].count, 2)
    assert.equal(metrics.bytes.packs, 5_000)
    assert.equal(metrics.bytes.snapshots, 200)
    assert.equal(metrics.bytes.records, 300)
    assert.equal(metrics.disruptions.http429, 1)
    // The first read from the start is the bootstrap itself; the second is a restart.
    assert.equal(metrics.disruptions.restartsFromZero, 1)
  })

  it('reports bodies as not reached and still measures up to the last request', () => {
    const metrics = summarize({
      marks: { startMs: 0, recordsMs: null, bodiesMs: null },
      lineMbps: 100,
      requests: [request({ path: '/sync/pull', method: 'POST', startMs: 10, endMs: 20 })]
    })
    assert.equal(metrics.tBodiesMs, null)
    assert.equal(metrics.requests.total, 1)
    assert.match(formatReport('core', metrics), /t_bodies \| not reached/)
  })

  it('counts refused writes apart from traffic and reports attachment bytes', () => {
    const metrics = summarize({
      marks: { startMs: 0, recordsMs: null, bodiesMs: 1_000 },
      lineMbps: 100,
      requests: [
        request({ path: '/sync/changes', startMs: 10, endMs: 20 }),
        request({
          path: '/sync/push',
          method: 'POST',
          status: 403,
          refused: true,
          startMs: 30,
          endMs: 30
        }),
        request({
          path: '/sync/crdt/updates',
          method: 'POST',
          status: 403,
          refused: true,
          startMs: 40,
          endMs: 40
        }),
        request({
          path: '/sync/push',
          method: 'POST',
          status: 403,
          refused: true,
          startMs: 50,
          endMs: 50
        })
      ]
    })
    assert.equal(metrics.requests.total, 1)
    assert.equal(metrics.requests.writesRefused, 3)
    assert.deepEqual(metrics.requests.writesRefusedByEndpoint, {
      'POST /sync/push': 2,
      'POST /sync/crdt/updates': 1
    })
    assert.match(
      formatReport('core', metrics),
      /Writes refused \| 3 \(`POST \/sync\/push` 2, `POST \/sync\/crdt\/updates` 1\) in the window;/
    )
    assert.equal(metrics.bytes.attachments, 0)
    assert.match(formatReport('core', metrics), /Attachments \| 0 bytes \(out of scope\)/)

    const withAttachment = summarize({
      marks: { startMs: 0, recordsMs: null, bodiesMs: 1_000 },
      lineMbps: 100,
      requests: [
        request({ path: '/sync/attachments/presign-batch', method: 'POST', startMs: 10, endMs: 20 })
      ]
    })
    assert.equal(withAttachment.bytes.attachments, 100)
    assert.match(formatReport('core', withAttachment), /Attachments \| 0\.00 MB: NOT ZERO/)
  })

  it('reports how many requests each endpoint had in flight at once', () => {
    const metrics = summarize({
      marks: { startMs: 0, recordsMs: null, bodiesMs: 1_000 },
      lineMbps: 100,
      requests: [
        request({ path: '/sync/crdt/snapshot/a', startMs: 0, endMs: 100 }),
        request({ path: '/sync/crdt/snapshot/b', startMs: 50, endMs: 150 }),
        request({ path: '/sync/crdt/snapshot/c', startMs: 60, endMs: 70 }),
        request({ path: '/sync/crdt/snapshot/d', startMs: 150, endMs: 200 }),
        request({ path: '/sync/changes', startMs: 0, endMs: 10 })
      ]
    })
    assert.equal(metrics.requests.byEndpoint['GET /sync/crdt/snapshot/:id'].maxInFlight, 3)
    assert.equal(metrics.requests.byEndpoint['GET /sync/changes'].maxInFlight, 1)
    assert.equal(metrics.requests.maxInFlight, 3)
    assert.equal(
      maxInFlight([request({ startMs: 0, endMs: 100 }), request({ startMs: 100, endMs: 200 })]),
      1
    )
  })

  it('splits the client sleeps out of idle network time', () => {
    const run = (sleeps) =>
      summarize({
        marks: { startMs: 0, recordsMs: null, bodiesMs: 10_000 },
        lineMbps: 100,
        sleeps,
        requests: [request({ path: '/sync/changes', startMs: 0, endMs: 1_000 })]
      }).limiter.kind
    assert.equal(run([[2_000, 6_000]]), 'client pacing')
    assert.equal(run([[2_000, 1_000]]), 'local apply')
    assert.equal(run(null), 'local apply or client pacing')
  })
})

describe('limiter', () => {
  it('names local work when the network sits idle most of the run', () => {
    assert.equal(
      limiterOf({ wallMs: 10_000, busy: 2_000, bytes: 1e6, requests: 50, lineMbps: 50 }).kind,
      'local apply or client pacing'
    )
  })
  it('judges line speed against the measured line', () => {
    const busyRun = { wallMs: 4_000, busy: 4_000, bytes: 10e6, requests: 10 }
    assert.equal(limiterOf({ ...busyRun, lineMbps: 30 }).kind, 'line speed')
    assert.equal(limiterOf({ ...busyRun, lineMbps: 500 }).kind, 'request latency × count')
  })
  it('names the line when busy throughput nears it, and latency otherwise', () => {
    assert.equal(
      limiterOf({ wallMs: 4_000, busy: 4_000, bytes: 20e6, requests: 10, lineMbps: 50 }).kind,
      'line speed'
    )
    assert.equal(
      limiterOf({ wallMs: 4_000, busy: 4_000, bytes: 1e6, requests: 400, lineMbps: 50 }).kind,
      'request latency × count'
    )
  })
  it('counts overlapping requests once', () => {
    assert.equal(
      busyMs([
        request({ startMs: 0, endMs: 100 }),
        request({ startMs: 50, endMs: 150 }),
        request({ startMs: 300, endMs: 400 })
      ]),
      250
    )
  })
})

describe('endpointOf', () => {
  it('folds ids out of paths and keeps route words', () => {
    assert.equal(
      endpointOf(request({ path: '/sync/crdt/snapshot/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0' })),
      'GET /sync/crdt/snapshot/:id'
    )
    assert.equal(endpointOf(request({ path: '/sync/changes?limit=500' })), 'GET /sync/changes')
    // Journal ids and short ids carry no uuid shape; the route decides.
    assert.equal(
      endpointOf(request({ path: '/sync/crdt/snapshot/j2099-10-16' })),
      'GET /sync/crdt/snapshot/:id'
    )
    assert.equal(
      endpointOf(request({ method: 'POST', path: '/sync/crdt/snapshot/batch' })),
      'POST /sync/crdt/snapshot/batch'
    )
  })
})

describe('electron main.log', () => {
  const log = [
    '2026-11-19 12:00:00.000 [info]  [ (Auth)        ] Device registered',
    "2026-11-19 12:00:10.000 [info]  [ (BootstrapMetrics) ] Bootstrap window opened { source: 'vault_download' }",
    '2026-11-19 12:00:15.000 [debug] [ (PullCoordinator) ] Pull records applied { pulled: 150 }',
    '2026-11-19 12:00:20.000 [debug] [ (CrdtSyncCoordinator) ] pullCrdtForNotes completed { count: 100, snapshotGets: 100, batchPosts: 1 }',
    '2026-11-19 12:00:30.000 [debug] [ (CrdtSyncCoordinator) ] pullCrdtForNotes completed { count: 50, snapshotGets: 40, batchPosts: 1 }',
    '2026-11-19 12:01:00.000 [info]  [ (PullCoordinator) ] Pull timing { totalMs: 50000 }',
    '2026-11-19 12:01:01.000 [error] [ (SyncEngine) ] Sync lock held past stale threshold — force releasing { heldForMs: 900000 }',
    '2026-11-19 12:02:00.000 [info]  [ (BootstrapMetrics) ] Bootstrap window closed { durationMs: 110000 }'
  ].join('\n')

  it('reads the three marks and the shell-only counts', () => {
    const parsed = electronMarks(parseMainLog(log))
    // Records end when the last record applies, not at `Pull timing`, which
    // waits for the run's last body batch.
    assert.equal(parsed.marks.recordsMs - parsed.marks.startMs, 5_000)
    assert.equal(parsed.marks.bodiesMs - parsed.marks.startMs, 110_000)
    assert.equal(parsed.staleLockReleases, 1)
    assert.equal(parsed.shell.snapshotGets, 140)
    assert.equal(parsed.shell.crdtGroups, 2)
  })

  it('keeps the first lines when the logger rotates main.log', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-log-'))
    const live = path.join(dir, 'main.log')
    const [, opened, applied, , , , , closed] = log.split('\n')
    try {
      fs.writeFileSync(live, `${opened}\n`)
      const read = followLog(live, fs)
      read()
      fs.appendFileSync(live, `${applied}\nnoise line\n`)
      fs.renameSync(live, path.join(dir, 'main.1.log'))
      fs.writeFileSync(live, `${closed}\n`)
      const parsed = electronMarks(parseMainLog(read().join('\n')))
      assert.equal(parsed.marks.recordsMs - parsed.marks.startMs, 5_000)
      assert.equal(parsed.marks.bodiesMs - parsed.marks.startMs, 110_000)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('has no marks before a vault download starts', () => {
    assert.equal(electronMarks(parseMainLog(log.split('\n')[0])), null)
  })
})

describe('proxy', () => {
  it('records each request and rewrites pack urls to come back through it', async () => {
    // A plain-HTTP upstream is enough to prove the R2 rewrite round trip.
    const upstream = http.createServer((req, res) => {
      if (req.url.startsWith('/sync/packs')) {
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({ packs: [{ id: 'p1', url: `http://127.0.0.1:${port}/r2/p1?sig=a` }] })
        )
      } else {
        res.end('pack-bytes')
      }
    })
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const port = upstream.address().port
    const proxy = await startProxy({ upstream: `http://127.0.0.1:${port}` })
    try {
      const listed = await (await fetch(`${proxy.url}/sync/packs?limit=50`)).json()
      assert.ok(listed.packs[0].url.startsWith(`${proxy.url}/__r2/`))
      assert.equal(await (await fetch(listed.packs[0].url)).text(), 'pack-bytes')
      assert.deepEqual(
        proxy.requests.map((r) => [r.host, r.path, r.resBytes]),
        [
          ['worker', '/sync/packs?limit=50', proxy.requests[0].resBytes],
          ['r2', '/r2/p1?sig=a', 10]
        ]
      )
    } finally {
      await proxy.close()
      upstream.close()
    }
  })
})

describe('proxy guards', () => {
  it('allows only staging and loopback, by exact hostname', () => {
    for (const allowed of [
      'https://sync-staging.memrynote.com',
      'https://SYNC-STAGING.memrynote.com',
      'http://127.0.0.1:8787',
      'http://localhost:8787'
    ]) {
      assert.doesNotThrow(() => assertAllowedUpstream(allowed), allowed)
    }
    for (const refused of [
      'https://sync.memrynote.com',
      'https://SYNC.MEMRYNOTE.COM',
      'https://sync.memrynote.com.example.net',
      'https://evil.sync-staging.memrynote.com',
      'https://sync-staging.memrynote.com.example.net',
      'https://localhost.example.net'
    ]) {
      assert.throws(() => assertAllowedUpstream(refused), /out of bounds/, refused)
    }
  })

  it('refuses production before it listens', async () => {
    await assert.rejects(startProxy({ upstream: 'https://SYNC.MEMRYNOTE.COM' }), /out of bounds/)
  })

  it('answers write routes with 403 itself and forwards the reads', async () => {
    const seen = []
    const upstream = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`)
      req.resume()
      req.on('end', () => res.end('{}'))
    })
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const proxy = await startProxy({ upstream: `http://127.0.0.1:${upstream.address().port}` })
    const send = async (method, route) => {
      const init = method === 'GET' ? {} : { method, body: '{}' }
      return (await fetch(`${proxy.url}${route}`, init)).status
    }
    try {
      const writes = [
        ['POST', '/sync/push'],
        ['POST', '/sync/records/push'],
        ['POST', '/sync/crdt/updates'],
        ['POST', '/sync/crdt/snapshot'],
        ['POST', '/sync/crdt/snapshot/batch'],
        ['PUT', '/sync/crdt/snapshot/note-1'],
        ['POST', '/sync/vaults'],
        ['PUT', '/sync/vaults/x/icon'],
        ['DELETE', '/sync/vaults/x'],
        ['POST', '/sync/attachments/upload/initiate'],
        ['POST', '/sync/attachments/dereference']
      ]
      for (const [method, route] of writes) assert.equal(await send(method, route), 403, route)
      const reads = [
        ['POST', '/sync/pull'],
        ['POST', '/sync/records/pull'],
        ['POST', '/sync/crdt/updates/batch'],
        ['GET', '/sync/crdt/updates?noteId=n'],
        ['GET', '/sync/crdt/snapshot/note-1'],
        ['POST', '/sync/bootstrap'],
        ['POST', '/sync/bootstrap/renew'],
        ['POST', '/sync/bootstrap/close'],
        ['POST', '/sync/attachments/presign-batch'],
        ['POST', '/auth/otp/verify'],
        ['POST', '/auth/devices']
      ]
      for (const [method, route] of reads) assert.equal(await send(method, route), 200, route)
      assert.deepEqual(
        seen,
        reads.map(([method, route]) => `${method} ${route}`)
      )
      assert.equal(proxy.requests.filter((r) => r.refused).length, writes.length)
    } finally {
      await proxy.close()
      upstream.close()
    }
  })
})

describe('rust-core shells', () => {
  const vaultDb = (file, keys) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    for (const key of keys) db.prepare('INSERT INTO meta VALUES (?, ?)').run(key, '0:0')
    db.close()
  }

  it('reads the body debt of the vault that is bootstrapping', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-db-'))
    try {
      vaultDb(path.join(dir, 'other/.memry/data.db'), ['sync.cursor'])
      const bootstrapping = path.join(dir, 'vaults/v1/data.db')
      vaultDb(bootstrapping, [
        'sync.server_vault_id',
        'sync.body_owed:a',
        'sync.body_owed:b',
        'sync.body_owed;not-a-debt',
        'sync.body_owe:x'
      ])
      assert.equal(findBootstrapDb([dir], 0), bootstrapping)
      assert.deepEqual(bodyDebt(bootstrapping), { bound: true, completed: false, owed: 2 })
      // A vault left by an earlier run is older than this run's start.
      assert.equal(findBootstrapDb([dir], Date.now() + 60_000), null)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('says every body is local once the first sync completed and nothing is owed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-db-'))
    try {
      const file = path.join(dir, 'data.db')
      vaultDb(file, ['sync.server_vault_id', 'first_sync.completed'])
      assert.deepEqual(bodyDebt(file), { bound: true, completed: true, owed: 0 })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads the iOS marks from the unified log stream', () => {
    const at = (time, eventMessage) =>
      JSON.stringify({ timestamp: `2026-11-20 01:00:${time}+0000`, eventMessage })
    const marks = iosMarks([
      'Filtering the log data using "subsystem == \\"com.memry.ios\\""',
      at('00.000000', 'read the vault registry'),
      at('01.500250', 'a first sync started'),
      at('02.000000', 'the first sync is pulling metadata'),
      at('09.250000', 'the first sync is pulling bodies'),
      at('30.000000', 'a first sync finished'),
      at('40.000000', 'a first sync started')
    ])
    const start = Date.parse('2026-11-20T01:00:01.500Z')
    assert.equal(marks.startMs, start)
    assert.equal(marks.recordsMs - start, 7_750)
    assert.equal(marks.firstSyncMs - start, 28_500)
  })

  it('reads the Tauri start from main.log, also across a rotation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-log-'))
    const live = path.join(dir, 'main.log')
    try {
      fs.writeFileSync(live, '2026-11-20 01:00:00.000 [info] [auth] signed in\n')
      const read = followLog(live, fs, ['bootstrap window'])
      assert.equal(tauriStartMs(read()), null)
      fs.appendFileSync(
        live,
        '2026-11-20 01:00:05.250 [info] [telemetry] bootstrap window opened source=vault_download\n'
      )
      fs.renameSync(live, path.join(dir, 'main.1.log'))
      fs.writeFileSync(live, '2026-11-20 01:00:06.000 [info] [sync] sync signal\n')
      assert.equal(tauriStartMs(read()), new Date(2026, 10, 20, 1, 0, 5, 250).getTime())
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('marks records at the feed head and the item fetches of its page', () => {
    const page = (startMs, hasMore) =>
      request({ path: '/sync/changes?cursor=1', startMs, endMs: startMs + 100, hasMore })
    const pull = (startMs) =>
      request({ method: 'POST', path: '/sync/pull', startMs, endMs: startMs + 300 })
    const body = (startMs) =>
      request({ path: '/sync/crdt/snapshot/n', startMs, endMs: startMs + 50 })
    const requests = [
      page(500, false),
      page(1_000, true),
      pull(1_200),
      page(2_000, false),
      pull(2_200),
      pull(2_300),
      request({ host: 'r2', path: '/p?sig=x', startMs: 2_400, endMs: 3_000 }),
      body(2_700),
      pull(5_000)
    ]
    assert.equal(feedHeadMs(requests, 1_000), 2_600)
    assert.equal(feedHeadMs(requests.slice(1, 3), 1_000), null)
  })

  it('reads hasMore off a compressed feed page', async () => {
    const upstream = http.createServer((req, res) => {
      res.setHeader('content-encoding', 'gzip')
      res.end(zlib.gzipSync(JSON.stringify({ items: [], hasMore: req.url.includes('more') })))
    })
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const proxy = await startProxy({ upstream: `http://127.0.0.1:${upstream.address().port}` })
    try {
      // fetch decodes the gzip body itself, so the shell still gets the page.
      assert.deepEqual(await (await fetch(`${proxy.url}/sync/changes?more=1`)).json(), {
        items: [],
        hasMore: true
      })
      await fetch(`${proxy.url}/sync/changes?cursor=9`)
      assert.deepEqual(
        proxy.requests.map((r) => r.hasMore),
        [true, false]
      )
    } finally {
      await proxy.close()
      upstream.close()
    }
  })

  it('counts refused push items by type and operation over the whole session', async () => {
    const upstream = http.createServer((req, res) => res.end('{}'))
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const proxy = await startProxy({ upstream: `http://127.0.0.1:${upstream.address().port}` })
    const item = (type, operation) => ({ id: 'x', type, operation, encryptedData: 'c2VjcmV0' })
    const push = (items) =>
      fetch(`${proxy.url}/sync/push`, { method: 'POST', body: JSON.stringify({ items }) })
    try {
      await push([item('note', 'create'), item('note', 'create'), item('folder_config', 'create')])
      await push([item('note', 'update')])
      await fetch(`${proxy.url}/sync/crdt/updates`, { method: 'POST', body: 'binary' })
      const metrics = summarize({
        requests: proxy.requests,
        // The pushes land after the window closed and still count.
        marks: { startMs: 0, bodiesMs: 1 },
        lineMbps: 100
      })
      assert.deepEqual(metrics.requests.sessionRefused, {
        requests: 3,
        items: { 'note:create': 2, 'folder_config:create': 1, 'note:update': 1, other: 1 }
      })
      assert.equal(metrics.requests.writesRefused, 0)
      assert.match(formatReport('t', metrics), /whole session 3 requests, items note:create 2, /)
      assert.doesNotMatch(JSON.stringify(proxy.requests), /c2VjcmV0/)
    } finally {
      await proxy.close()
      upstream.close()
    }
  })
})
