/**
 * SQLite driver benchmark (spec 001-mobile-app T009 / R2, G0-c).
 *
 * Driver DECIDED 2026-08-23: expo-sqlite (research.md §R2). The rig validates
 * the §R2 workload thresholds against it on the physical reference device in a
 * RELEASE build (debug numbers are not evidence). Workloads mirror our real
 * shapes:
 *   (a) bulk insert 10k sync_items + 10k ~2 KB bodies in transactions  ≤ 10 s
 *   (b) 1k random point reads                                     p95 ≤ 5 ms
 *   (c) FTS5 build over the 10k corpus + 100 ranked queries
 *       build ≤ 15 s, query p95 ≤ 30 ms
 *   (d) Yjs pattern: 5k × ~200 B BLOB appends + full-log replay
 *       append p95 ≤ 5 ms, replay ≤ 2 s
 *   (e) cold open → first query                                       ≤ 300 ms
 *
 * G0-c passes when all five thresholds hold; a failure sends us back to
 * schema/indexing before any driver re-litigation (written decision required).
 */

export interface BenchDriver {
  name: string
  open(dbName: string): Promise<BenchConnection>
  /** Delete the database file so cold-open is honest. */
  remove(dbName: string): Promise<void>
}

export interface BenchConnection {
  exec(sql: string): Promise<void>
  run(sql: string, params: readonly (string | number | Uint8Array)[]): Promise<void>
  /** Prepared-statement loop — how the real sync pipeline bulk-inserts. */
  runBatch(sql: string, rows: readonly (readonly (string | number | Uint8Array)[])[]): Promise<void>
  queryAll<T>(sql: string, params?: readonly (string | number)[]): Promise<T[]>
  transaction(fn: (conn: BenchConnection) => Promise<void>): Promise<void>
  close(): Promise<void>
}

export interface WorkloadResult {
  name: string
  totalMs: number
  p95Ms?: number
  threshold: string
  pass: boolean
}

export interface DriverBenchReport {
  driver: string
  results: WorkloadResult[]
  allPass: boolean
}

const ITEM_COUNT = 10_000
const POINT_READS = 1_000
const FTS_QUERIES = 100
const YJS_APPENDS = 5_000

const now = (): number => performance.now()

const p95 = (samples: number[]): number => {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
}

// Deterministic pseudo-random content so both drivers see identical data.
const mulberry32 = (seed: number) => () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const WORDS = [
  'vault',
  'note',
  'sync',
  'offline',
  'crdt',
  'merge',
  'journal',
  'task',
  'calendar',
  'inbox',
  'canvas',
  'bookmark',
  'filter',
  'memry',
  'mobile',
  'parity',
  'encrypt',
  'markdown',
  'frontmatter',
  'outbox'
]

const makeBody = (rand: () => number, index: number): string => {
  const parts: string[] = [`# Note ${index}\n`]
  // ~2 KB of word soup, deterministic per index.
  while (parts.join(' ').length < 2048) {
    parts.push(WORDS[Math.floor(rand() * WORDS.length)])
  }
  return parts.join(' ')
}

const makeBlob = (rand: () => number): Uint8Array => {
  const blob = new Uint8Array(200)
  for (let i = 0; i < blob.length; i++) {
    blob[i] = Math.floor(rand() * 256)
  }
  return blob
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sync_items (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    payload_state TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS note_bodies (
    note_id TEXT PRIMARY KEY,
    markdown TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS yjs_updates (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT NOT NULL,
    update_blob BLOB NOT NULL
  );
`

export const runDriverBench = async (driver: BenchDriver): Promise<DriverBenchReport> => {
  const dbName = `bench-${driver.name}.db`
  await driver.remove(dbName)

  const results: WorkloadResult[] = []
  let conn = await driver.open(dbName)
  await conn.exec(SCHEMA)

  // (a) bulk insert — prepared statements inside one transaction, the shape
  // the real first-sync pipeline uses. A first device run with per-row
  // runAsync round-trips measured 11.7 s (rig overhead, not the driver);
  // per research.md the rig gets fixed before any driver blame.
  {
    const rand = mulberry32(42)
    const itemRows: (string | number)[][] = []
    const bodyRows: string[][] = []
    for (let i = 0; i < ITEM_COUNT; i++) {
      itemRows.push([`item-${i}`, 'note', 1_700_000_000 + i, 'full'])
      bodyRows.push([`item-${i}`, makeBody(rand, i)])
    }

    const start = now()
    await conn.transaction(async (tx) => {
      await tx.runBatch(
        'INSERT INTO sync_items (id, type, updated_at, payload_state) VALUES (?, ?, ?, ?)',
        itemRows
      )
      await tx.runBatch('INSERT INTO note_bodies (note_id, markdown) VALUES (?, ?)', bodyRows)
    })
    const totalMs = now() - start
    results.push({
      name: 'bulk insert 10k+10k',
      totalMs,
      threshold: '≤ 10 s',
      pass: totalMs <= 10_000
    })
  }

  // (b) random point reads
  {
    const rand = mulberry32(7)
    const samples: number[] = []
    for (let i = 0; i < POINT_READS; i++) {
      const id = `item-${Math.floor(rand() * ITEM_COUNT)}`
      const start = now()
      await conn.queryAll('SELECT markdown FROM note_bodies WHERE note_id = ?', [id])
      samples.push(now() - start)
    }
    const value = p95(samples)
    results.push({
      name: '1k point reads',
      totalMs: samples.reduce((a, b) => a + b, 0),
      p95Ms: value,
      threshold: 'p95 ≤ 5 ms',
      pass: value <= 5
    })
  }

  // (c) FTS5 build + ranked queries
  {
    const start = now()
    await conn.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(note_id UNINDEXED, markdown);
      INSERT INTO note_fts (note_id, markdown) SELECT note_id, markdown FROM note_bodies;
    `)
    const buildMs = now() - start
    results.push({
      name: 'FTS5 build 10k',
      totalMs: buildMs,
      threshold: '≤ 15 s',
      pass: buildMs <= 15_000
    })

    const rand = mulberry32(13)
    const samples: number[] = []
    for (let i = 0; i < FTS_QUERIES; i++) {
      const term = WORDS[Math.floor(rand() * WORDS.length)]
      const start2 = now()
      await conn.queryAll(
        'SELECT note_id FROM note_fts WHERE note_fts MATCH ? ORDER BY rank LIMIT 20',
        [term]
      )
      samples.push(now() - start2)
    }
    const value = p95(samples)
    results.push({
      name: '100 ranked FTS queries',
      totalMs: samples.reduce((a, b) => a + b, 0),
      p95Ms: value,
      threshold: 'p95 ≤ 30 ms',
      pass: value <= 30
    })
  }

  // (d) Yjs pattern: blob appends + replay
  {
    const rand = mulberry32(99)
    const samples: number[] = []
    for (let i = 0; i < YJS_APPENDS; i++) {
      const blob = makeBlob(rand)
      const start = now()
      await conn.run('INSERT INTO yjs_updates (doc_id, update_blob) VALUES (?, ?)', ['doc-1', blob])
      samples.push(now() - start)
    }
    const appendP95 = p95(samples)
    results.push({
      name: '5k blob appends',
      totalMs: samples.reduce((a, b) => a + b, 0),
      p95Ms: appendP95,
      threshold: 'p95 ≤ 5 ms',
      pass: appendP95 <= 5
    })

    const start = now()
    await conn.queryAll<{ update_blob: Uint8Array }>(
      'SELECT update_blob FROM yjs_updates WHERE doc_id = ? ORDER BY seq',
      ['doc-1']
    )
    const replayMs = now() - start
    results.push({
      name: 'full log replay',
      totalMs: replayMs,
      threshold: '≤ 2 s',
      pass: replayMs <= 2_000
    })
  }

  // (e) cold open → first query
  {
    // expo-sqlite (SDK 57) segfaults in sqlite3Fts5IndexClose when closing a
    // connection that still holds the FTS5 vtab (SIGSEGV in exsqlite3_close —
    // observed on the simulator, crash report 2026-08-23). Dropping the table
    // first frees the vtab safely; (c) has already measured FTS by now.
    // R2 finding: re-test on device; if it persists, upstream issue + the
    // real app must drop/detach FTS vtabs before any deliberate close.
    await conn.exec('DROP TABLE IF EXISTS note_fts')
    await conn.close()
    const start = now()
    conn = await driver.open(dbName)
    await conn.queryAll('SELECT id FROM sync_items ORDER BY updated_at DESC LIMIT 50')
    const coldMs = now() - start
    results.push({
      name: 'cold open → first query',
      totalMs: coldMs,
      threshold: '≤ 300 ms',
      pass: coldMs <= 300
    })
  }

  await conn.close()
  return { driver: driver.name, results, allPass: results.every((r) => r.pass) }
}

export const formatReport = (report: DriverBenchReport): string => {
  const rows = report.results.map((r) => {
    const p95Col = r.p95Ms === undefined ? '—' : `${r.p95Ms.toFixed(2)} ms`
    return `| ${r.name} | ${r.totalMs.toFixed(0)} ms | ${p95Col} | ${r.threshold} | ${r.pass ? 'PASS' : 'FAIL'} |`
  })
  return [
    `### ${report.driver} — ${report.allPass ? 'ALL PASS' : 'FAIL'}`,
    '| workload | total | p95 | threshold | result |',
    '|---|---|---|---|---|',
    ...rows
  ].join('\n')
}
