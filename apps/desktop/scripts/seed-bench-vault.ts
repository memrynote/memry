#!/usr/bin/env npx tsx
/**
 * Benchmark seed — fills a vault with a large number of fully-written notes.
 *
 * `seed:vault` is the hand-authored demo vault (small, good for screenshots).
 * This one is the opposite: 1000 notes by default, every one with headings,
 * lists, a table, checkboxes, code blocks and wiki-links, so indexing, search,
 * the graph, and the notes list all get realistic work to do.
 *
 * Default target: ~/MemryBenchVault. Override with --vault=<path>.
 * Always wipes and re-seeds. The same --seed/--count produce the same vault.
 */

import { statSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'

import { wipeVault } from './seed-vault/wipe'
import { writeNoteFiles } from './seed-vault/file-writer'
import {
  insertFolderConfigs,
  insertNoteMetadata,
  insertPropertyDefinitions,
  insertTagDefinitions,
  openDataDb
} from './seed-vault/db-writer'
import type { SeedNoteMetadata } from './seed-vault/db-writer'
import { generateBulkVault } from './seed-data/bulk-notes'

interface CliArgs {
  vaultPath: string
  count: number
  seed: number
}

function parseNumber(raw: string, flag: string, min: number): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`--${flag} must be an integer >= ${min}, got: ${raw}`)
  }
  return value
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {}
  for (const raw of argv) {
    if (raw.startsWith('--vault=')) args.vaultPath = resolve(raw.slice('--vault='.length))
    if (raw.startsWith('--count='))
      args.count = parseNumber(raw.slice('--count='.length), 'count', 1)
    if (raw.startsWith('--seed=')) args.seed = parseNumber(raw.slice('--seed='.length), 'seed', 0)
  }
  return {
    vaultPath: args.vaultPath ?? resolve(homedir(), 'MemryBenchVault'),
    count: args.count ?? 1000,
    seed: args.seed ?? 42
  }
}

// One colour per tag so the sidebar and tag hub are not a wall of grey.
const TAG_COLORS = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#a855f7',
  '#0ea5e9',
  '#22c55e',
  '#ec4899',
  '#f97316',
  '#6366f1',
  '#84cc16',
  '#14b8a6'
]

// Mirrors the frontmatter keys `generateBulkVault` writes on every note.
const PROPERTY_DEFS = [
  { name: 'status', type: 'text', color: '#6366f1' },
  { name: 'priority', type: 'text', color: '#ef4444' },
  { name: 'owner', type: 'text', color: '#6b7280' },
  { name: 'rating', type: 'number', color: '#f59e0b' }
]

/** SQLite caps bound parameters per statement; note_metadata is 7 columns wide. */
const INSERT_CHUNK = 400

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

function writeMinimalConfig(vaultPath: string): void {
  writeFileSync(
    resolve(vaultPath, '.memry', 'config.json'),
    JSON.stringify(
      {
        version: 1,
        title: 'memrynote Benchmark Vault',
        excludePatterns: ['.git', 'node_modules', '.DS_Store']
      },
      null,
      2
    ),
    'utf8'
  )
}

async function main(): Promise<void> {
  const { vaultPath, count, seed } = parseArgs(process.argv.slice(2))

  console.log(`Seeding benchmark vault at: ${vaultPath}`)
  console.log(`  → ${count} notes, seed ${seed}`)

  console.log('  → Generating note content...')
  const vault = generateBulkVault(count, seed)

  console.log('  → Wiping existing contents...')
  wipeVault(vaultPath)

  console.log('  → Writing .memry/config.json')
  writeMinimalConfig(vaultPath)

  const dataDbPath = resolve(vaultPath, '.memry', 'data.db')
  console.log(`  → Opening + migrating data.db at ${dataDbPath}`)
  const { db, raw, close } = openDataDb(dataDbPath)

  try {
    raw.transaction(() => {
      insertFolderConfigs(db, vault.folders)
      insertTagDefinitions(
        db,
        vault.tags.map((name, i) => ({ name, color: TAG_COLORS[i % TAG_COLORS.length] }))
      )
      insertPropertyDefinitions(db, PROPERTY_DEFS)

      // Canonical rows so note ids stay stable when the indexer adopts the
      // files by path — the same contract the demo seed relies on.
      const metadata: SeedNoteMetadata[] = vault.notes.map((note) => ({
        id: note.id,
        path: note.path,
        title: note.title,
        emoji: note.emoji,
        createdAt: note.createdAt,
        modifiedAt: note.modifiedAt
      }))
      for (const batch of chunk(metadata, INSERT_CHUNK)) {
        insertNoteMetadata(db, batch)
      }
    })()

    console.log(`  → folder_configs: ${vault.folders.length}`)
    console.log(`  → tag_definitions: ${vault.tags.length}`)
    console.log(`  → property_definitions: ${PROPERTY_DEFS.length}`)
    console.log(`  → note_metadata: ${vault.notes.length}`)
  } finally {
    close()
  }

  console.log(`  → Writing ${vault.notes.length} note files`)
  const written = writeNoteFiles(
    vaultPath,
    vault.notes.map((note) => note.file)
  )

  const totalBytes = vault.notes.reduce(
    (sum, note) => sum + statSync(resolve(vaultPath, note.path)).size,
    0
  )

  console.log('')
  console.log('Done.')
  console.log(
    `Seeded ${written} notes across ${vault.folders.length} folders, ` +
      `${vault.tags.length} tags, ${(totalBytes / 1024 / 1024).toFixed(2)} MB of markdown ` +
      `(avg ${Math.round(totalBytes / written)} bytes/note).`
  )
  console.log(`Vault path: ${vaultPath}`)
  console.log('')
  console.log('Open memrynote → Switch Vault → choose this path to benchmark.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
