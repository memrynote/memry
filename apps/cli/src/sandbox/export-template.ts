// `pnpm --filter @memry/cli sandbox:export-template`: one-time export of the
// sandbox vault this generator builds, for the Tauri app's replay engine
// (memry_desktop::sandbox, Step 32 of #3517, issue #3549). It runs the real
// generator at a fixed moment in UTC (bin/sandbox.mjs sets TZ=UTC), then writes
// into crates/memry-desktop/resources/sandbox/:
// - vault/: every vault file except the databases and the byte copies of
//   bundled assets, byte for byte;
// - seed.json: the database rows the generator left behind (data.db and
//   index.db), clocks and device ids dropped, plus the asset copies by path;
// - manifest.json: the moment, the time zone and the generator's count table.
// The template is frozen once committed: rerunning it mints new ids.
//
// `-- --rebase-vector=<ISO instant>` instead runs the generator at that moment
// and writes the date facts it produced (vault paths, dates in note text and
// date tokens, dated database values) to
// crates/memry-desktop/tests/fixtures/sandbox/rebase-<date>.json. The Rust
// rebase of the committed template to the same moment must reproduce them.
// `--tz=<IANA name>` runs that generator in another zone and adds the zone
// to the file name (rebase-<date>-<zone>.json).
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'

import { getDataDbPath, getIndexDbPath } from '../app-core/paths.ts'

const TEMPLATE_NOW = '2026-01-14T12:00:00.000Z'
const VECTOR_ARG = process.argv.find((arg) => arg.startsWith('--rebase-vector='))
const ZONE = process.argv.find((arg) => arg.startsWith('--tz='))?.slice('--tz='.length)
if (ZONE && !VECTOR_ARG) throw new Error('--tz is for --rebase-vector only; templates are UTC')
// Node reads TZ again when it changes, so this applies before any date is formatted.
if (ZONE) process.env.TZ = ZONE
const FIXED_NOW = Date.parse(
  VECTOR_ARG ? VECTOR_ARG.slice('--rebase-vector='.length) : TEMPLATE_NOW
)
const SEED_VERSION = 1
const CRATE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../crates/memry-desktop'
)
const OUT_DIR = path.join(CRATE_DIR, 'resources/sandbox')

/** The tables the generator writes. Device-local queues and caches are left for the app to derive. */
const DATA_TABLES = [
  'settings',
  'property_definitions',
  'note_metadata',
  'tag_categories',
  'tag_definitions',
  'templates',
  'folder_configs',
  'projects',
  'statuses',
  'project_links',
  'tasks',
  'task_tags',
  'task_notes',
  'task_canvases',
  'task_activity',
  'calendar_events',
  'reminders',
  'inbox_items',
  'inbox_item_tags',
  'filing_history',
  'inbox_stats',
  'saved_filters',
  'bookmarks',
  'home_pages',
  'recently_opened',
  'vault_locks'
] as const
const INDEX_TABLES = ['note_snapshots'] as const

/** Sync state and device identity: the replay takes them from the core it writes through. */
const DROPPED_COLUMNS = new Set(['clock', 'field_clocks', 'synced_at', 'stored_at', 'device_id'])

type Row = Record<string, unknown>

/**
 * Runs the generator's JavaScript clock from FIXED_NOW, keeping elapsed time so
 * ordering survives. SQLite's own `now` defaults still read the real clock;
 * `normalizeRealClock` maps those values onto the same timeline.
 */
function installFixedClock(): { realStart: number; realNow: () => number } {
  const RealDate = Date
  const realStart = RealDate.now()
  const offset = FIXED_NOW - realStart
  class FixedDate extends RealDate {
    constructor(...args: ConstructorParameters<typeof Date> | []) {
      if (args.length === 0) super(RealDate.now() + offset)
      else super(...args)
    }
    static override now(): number {
      return RealDate.now() + offset
    }
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a subclass of Date stands in for the global; only `new` and `now` are called on it
  globalThis.Date = FixedDate as DateConstructor
  return { realStart, realNow: () => RealDate.now() }
}

const SQL_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

/** Rewrites a value stamped by SQLite's real clock during [realStart, realEnd] onto the fixed timeline. */
function normalizeRealClock(value: unknown, realStart: number, realEnd: number): unknown {
  if (typeof value !== 'string') return value
  const sql = SQL_TIME.test(value)
  if (!sql && !ISO_INSTANT.test(value)) return value
  const at = Date.parse(sql ? `${value.replace(' ', 'T')}Z` : value)
  if (at < realStart - 1000 || at > realEnd + 1000) return value
  const fixed = new Date(FIXED_NOW + (at - realStart)).toISOString()
  return sql ? `${fixed.slice(0, 10)} ${fixed.slice(11, 19)}` : fixed
}

function dumpTables(
  dbPath: string,
  tables: readonly string[],
  realStart: number,
  realEnd: number
): Record<string, Row[]> {
  const db = new Database(dbPath, { readonly: true })
  try {
    const out: Record<string, Row[]> = {}
    for (const table of tables) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- better-sqlite3 rows are plain column objects
      const rows = db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() as Row[]
      out[table] = rows.map((row) =>
        Object.fromEntries(
          Object.entries(row)
            .filter(([column]) => !DROPPED_COLUMNS.has(column))
            .map(([column, value]) => [column, normalizeRealClock(value, realStart, realEnd)])
        )
      )
    }
    return out
  } finally {
    db.close()
  }
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex')
}

async function walk(dir: string, root = dir): Promise<string[]> {
  const files: string[] = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await walk(full, root)))
    else if (entry.isFile()) files.push(path.relative(root, full).split(path.sep).join('/'))
  }
  return files.toSorted()
}

const isDatabaseFile = (relative: string): boolean =>
  relative.startsWith('.memry/') && /\.db(-wal|-shm|-journal)?$/.test(relative)

// A date or instant not inside a longer digit run; the Rust test extracts with the same rule.
const DATE_FACT = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z?)?/g
const DATE_TOKEN = /\(\(date:([A-Za-z0-9,;]+)\)\)/g
/** Instants the generator sets from its clock alone (no elapsed run time in them). */
const CLOCK_INSTANTS = new Set([
  'calendar_events.start_at',
  'calendar_events.end_at',
  'reminders.remind_at',
  'reminders.snoozed_until',
  'inbox_items.snoozed_until'
])
/** Columns holding the device's IANA zone name. */
const ZONE_COLUMNS = new Set(['calendar_events.timezone'])

function dateFacts(text: string): string[] {
  const expanded = text.replace(DATE_TOKEN, (_, payload: string) =>
    atob(payload.replace(/,/g, '+').replace(/;/g, '/'))
  )
  const facts: string[] = []
  for (const match of expanded.matchAll(DATE_FACT)) {
    const before = expanded[match.index - 1] ?? ''
    const after = expanded[match.index + match[0].length] ?? ''
    if (!/\d/.test(before) && !/\d/.test(after)) facts.push(match[0])
  }
  return facts
}

async function writeRebaseVector(vault: string, at: string): Promise<void> {
  const files: Record<string, string[]> = {}
  const canvasTimes: Record<string, [number, number]> = {}
  const paths: string[] = []
  for (const relative of await walk(vault)) {
    if (isDatabaseFile(relative) || relative.startsWith('attachments/')) continue
    paths.push(relative)
    if (/\.(md|excalidraw)$/.test(relative)) {
      const facts = dateFacts(await fs.readFile(path.join(vault, relative), 'utf8'))
      if (facts.length > 0) files[relative] = facts
    }
    if (relative.endsWith('.excalidraw')) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the generator's own scene shape (steps/canvases.ts)
      const scene = JSON.parse(await fs.readFile(path.join(vault, relative), 'utf8')) as {
        memry: { createdAt: number; updatedAt: number }
      }
      canvasTimes[relative] = [scene.memry.createdAt, scene.memry.updatedAt]
    }
  }
  const values: Record<string, string[]> = {}
  const tables = dumpTables(getDataDbPath(vault), DATA_TABLES, 0, 0)
  // Due dates of repeating tasks by title: the rule-bound dates, checked on every weekday.
  const repeats: Record<string, unknown> = {}
  for (const task of tables.tasks) {
    if (task.repeat_config) repeats[String(task.title)] = task.due_date
  }
  for (const [table, rows] of Object.entries(tables)) {
    for (const row of rows) {
      for (const [column, value] of Object.entries(row)) {
        const key = `${table}.${column}`
        if (typeof value !== 'string') continue
        const listed = CLOCK_INSTANTS.has(key) || ZONE_COLUMNS.has(key)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value) && !listed) continue
        ;(values[key] ??= []).push(value)
      }
    }
  }
  for (const list of Object.values(values)) list.sort()
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const zoneSuffix = ZONE ? `-${ZONE.replace(/\//g, '-').toLowerCase()}` : ''
  const out = path.join(
    CRATE_DIR,
    'tests/fixtures/sandbox',
    `rebase-${at.slice(0, 10)}${zoneSuffix}.json`
  )
  await fs.mkdir(path.dirname(out), { recursive: true })
  const vector = { now: at, tz, paths, files, values, repeats, canvasTimes }
  await fs.writeFile(out, `${JSON.stringify(vector, null, 2)}\n`)
  process.stdout.write(`Rebase vector written to ${out}\n`)
}

async function main(): Promise<void> {
  if (process.env.TZ !== (ZONE ?? 'UTC'))
    throw new Error('Run through bin/sandbox.mjs, which sets TZ=UTC')
  const { realStart, realNow } = installFixedClock()
  // Lazy: the generator reads the clock while it runs, so it loads after the fixed clock is in place.
  const { generateSandbox } = await import('./generate.ts')
  const { ASSETS_DIR } = await import('./context.ts')

  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'memry-sandbox-template-'))
  try {
    const counts = await generateSandbox(vault, new Date(FIXED_NOW))
    const realEnd = realNow()
    if (VECTOR_ARG) {
      await writeRebaseVector(vault, new Date(FIXED_NOW).toISOString())
      return
    }

    const assetBySha = new Map<string, string>()
    for (const name of await fs.readdir(ASSETS_DIR)) {
      if (name !== 'manifest.json') assetBySha.set(await sha256(path.join(ASSETS_DIR, name)), name)
    }

    await fs.rm(OUT_DIR, { recursive: true, force: true })
    const assets: Array<{ path: string; asset: string; sha256: string }> = []
    let copied = 0
    for (const relative of await walk(vault)) {
      if (isDatabaseFile(relative)) continue
      const source = path.join(vault, relative)
      const digest = await sha256(source)
      const asset = assetBySha.get(digest)
      if (asset) {
        assets.push({ path: relative, asset, sha256: digest })
        continue
      }
      const target = path.join(OUT_DIR, 'vault', ...relative.split('/'))
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.copyFile(source, target)
      copied++
    }

    const generatedAt = new Date(FIXED_NOW).toISOString()
    const seed = {
      version: SEED_VERSION,
      generatedAt,
      timezone: 'UTC',
      assets,
      data: dumpTables(getDataDbPath(vault), DATA_TABLES, realStart, realEnd),
      index: dumpTables(getIndexDbPath(vault), INDEX_TABLES, realStart, realEnd)
    }
    const manifest = { version: SEED_VERSION, generatedAt, timezone: 'UTC', counts }
    await fs.writeFile(path.join(OUT_DIR, 'seed.json'), `${JSON.stringify(seed, null, 2)}\n`)
    await fs.writeFile(
      path.join(OUT_DIR, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`
    )
    process.stdout.write(
      `Sandbox template written to ${OUT_DIR}: ${copied} vault files, ${assets.length} asset copies\n`
    )
  } finally {
    await fs.rm(vault, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `sandbox:export-template: ${error instanceof Error ? error.message : String(error)}\n`
  )
  process.exitCode = 1
})
