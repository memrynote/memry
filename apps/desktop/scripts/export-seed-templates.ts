// `pnpm --filter @memry/desktop seed:export-templates`: one-time export of the demo, rich
// and small seed vaults for `cargo xtask seed demo|rich|small` (Step 40 of #3517, issue
// #3557). Each Electron seed script runs into a temp folder in UTC, then this writes, per
// profile, into crates/xtask/seed-data/<profile>/:
// - vault/: every vault file except the databases, byte for byte;
// - seed.json: the database rows the seed left in data.db, in the schema of
//   apps/cli/src/sandbox/export-template.ts (memry_desktop::sandbox::Manifest);
// - manifest.json: the export moment and the counts of the Electron vault, which the
//   Rust tests compare the replayed vault with.
// Step 43 (#3560) deletes it with the TypeScript seeds.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(SCRIPTS, '../../../crates/xtask/seed-data')
const SEED_VERSION = 1

const PROFILES = [
  { name: 'demo', script: 'seed-vault.ts', args: [] },
  { name: 'rich', script: 'seed-rich-vault.ts', args: [] },
  { name: 'small-1', script: 'seed-small-vault.ts', args: ['--variant=1'] },
  { name: 'small-2', script: 'seed-small-vault.ts', args: ['--variant=2'] }
] as const

/** The tables memry_desktop::sandbox::manifest::DATA_TABLES accepts. */
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

/** Sync state and device identity: the replay takes them from the core it writes through. */
const DROPPED_COLUMNS = new Set(['clock', 'field_clocks', 'synced_at', 'stored_at', 'device_id'])

type Row = Record<string, unknown>

function dumpTables(dbPath: string): Record<string, Row[]> {
  const db = new Database(dbPath, { readonly: true })
  try {
    const out: Record<string, Row[]> = {}
    for (const table of DATA_TABLES) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- better-sqlite3 rows are plain column objects
      const rows = db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() as Row[]
      out[table] = rows.map((row) =>
        Object.fromEntries(Object.entries(row).filter(([column]) => !DROPPED_COLUMNS.has(column)))
      )
    }
    return out
  } finally {
    db.close()
  }
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

/**
 * The replay refuses a path a Windows vault cannot hold (`:`); `meetings/1:1 with Ahmet.md`
 * becomes `meetings/1-1 with Ahmet.md`, in the file tree and in every row naming it.
 */
const portable = (relative: string): string => relative.replace(/:/g, '-')

/**
 * The replay mints a core id for each note and rewrites the template's ids it finds in text,
 * which it recognises as `note_` and 12 id characters (the sandbox generator's ids). The seeds
 * mint bare nanoids of 11 or 12, so each becomes `note_seed` and its 8-digit row number.
 * An attachment folder keeps the seed's name: a note whose attachment folder is named by its
 * own core id is not indexed by the first open (found while porting; reported on #3557).
 */
const ID_TOKEN = /(?<![A-Za-z0-9_-]|attachments\/)[A-Za-z0-9_-]+/g
function templateIds(rows: Row[]): (text: string) => string {
  const ids = new Map(
    rows.map((row, at) => [String(row.id), `note_seed${String(at).padStart(8, '0')}`])
  )
  return (text) => text.replace(ID_TOKEN, (token) => ids.get(token) ?? token)
}

const isDatabaseFile = (relative: string): boolean =>
  relative.startsWith('.memry/') && /\.db(-wal|-shm|-journal)?$/.test(relative)

/** What the Electron seed left on disk and in data.db. */
function countsOf(files: string[], data: Record<string, Row[]>): Record<string, number> {
  const inVault = files.filter((file) => !file.startsWith('.memry/'))
  const markdown = inVault.filter((file) => file.endsWith('.md'))
  const journal = markdown.filter((file) => file.startsWith('journal/'))
  return {
    notes: markdown.length - journal.length,
    'journal entries': journal.length,
    canvases: inVault.filter((file) => file.endsWith('.excalidraw')).length,
    tasks: data.tasks.length,
    projects: data.projects.length,
    'calendar events': data.calendar_events.length,
    'inbox items': data.inbox_items.length
  }
}

async function exportProfile(profile: (typeof PROFILES)[number], generatedAt: string) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), `memry-seed-${profile.name}-`))
  const vault = path.join(temp, 'vault')
  try {
    // Each seed script runs as its own process: it seeds on import.
    execFileSync(
      process.execPath,
      ['--import', 'tsx', path.join(SCRIPTS, profile.script), `--vault=${vault}`, ...profile.args],
      { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, TZ: 'UTC' } }
    )
    const out = path.join(OUT_DIR, profile.name)
    await fs.rm(out, { recursive: true, force: true })
    const files = (await walk(vault)).filter((file) => !isDatabaseFile(file))
    const renamed = new Set(files.filter((file) => portable(file) !== file))
    const data = dumpTables(path.join(vault, '.memry', 'data.db'))
    const withIds = templateIds(data.note_metadata)
    for (const rows of Object.values(data)) {
      for (const row of rows) {
        for (const [column, value] of Object.entries(row)) {
          if (typeof value !== 'string') continue
          row[column] = withIds(renamed.has(value) ? portable(value) : value)
        }
      }
    }
    for (const relative of files) {
      const source = path.join(vault, relative)
      const target = path.join(out, 'vault', ...withIds(portable(relative)).split('/'))
      await fs.mkdir(path.dirname(target), { recursive: true })
      if (/\.(md|excalidraw|json)$/.test(relative)) {
        await fs.writeFile(target, withIds(await fs.readFile(source, 'utf8')))
      } else {
        await fs.copyFile(source, target)
      }
    }
    const header = { version: SEED_VERSION, generatedAt, timezone: 'UTC' }
    const seed = { ...header, assets: [], data, index: {} }
    const manifest = { ...header, counts: countsOf(files, data) }
    await fs.writeFile(path.join(out, 'seed.json'), `${JSON.stringify(seed, null, 2)}\n`)
    await fs.writeFile(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    process.stdout.write(`${profile.name}: ${files.length} vault files\n`)
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  // The seeds' dates follow the run's local day: export in UTC, the zone the replay's rebase reads.
  if (process.env.TZ !== 'UTC') throw new Error('Run with TZ=UTC (the package script sets it)')
  const generatedAt = new Date().toISOString()
  for (const profile of PROFILES) await exportProfile(profile, generatedAt)
}

main().catch((error: unknown) => {
  process.stderr.write(
    `seed:export-templates: ${error instanceof Error ? error.message : String(error)}\n`
  )
  process.exitCode = 1
})
