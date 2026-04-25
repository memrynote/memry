#!/usr/bin/env tsx
/**
 * Create a new migration file with the next sequential number.
 *
 * Usage:
 *   pnpm db:new-migration "add_widgets_table"
 *
 * NOTE: After creating the file, you must manually add an entry to the
 * EMBEDDED list in `src-tauri/src/db/migrations.rs` — this script prints
 * the exact line to insert.
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = resolve(__dirname, '../src-tauri/migrations')
const MANIFEST_PATH = resolve(__dirname, '../src-tauri/src/db/migrations.rs')

function nextNumber(): string {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))
  if (files.length === 0) return '0001'
  const max = Math.max(...files.map((f) => Number(f.slice(0, 4))))
  return String(max + 1).padStart(4, '0')
}

function main() {
  const name = process.argv[2]
  if (!name) {
    console.error('Usage: pnpm db:new-migration "<snake_case_name>"')
    process.exit(1)
  }
  if (!/^[a-z0-9_]+$/.test(name)) {
    console.error('Name must be snake_case, lowercase, digits or underscores only.')
    process.exit(1)
  }

  const num = nextNumber()
  const filename = `${num}_${name}.sql`
  const target = resolve(MIGRATIONS_DIR, filename)

  if (existsSync(target)) {
    console.error(`${filename} already exists.`)
    process.exit(1)
  }

  writeFileSync(
    target,
    `-- ${filename}\n-- TODO: describe what this migration changes\n\n`,
  )

  console.log(`Created ${filename}`)
  console.log(
    `\nNext: add an entry to EMBEDDED in:\n  ${MANIFEST_PATH}\n\n` +
      `  ("${filename}", include_str!("../../migrations/${filename}")),\n\n` +
      `Also bump the array length in the migration_manifest module.`,
  )
}

main()
