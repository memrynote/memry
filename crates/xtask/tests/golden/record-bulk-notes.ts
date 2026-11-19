/**
 * Records the oracle `crates/xtask/tests/bulk_notes_golden.rs` holds the Rust bench generator to:
 * the sha256 of every note file the TypeScript generator writes, through its own file writer,
 * for each case below. Run from the repo root:
 *
 *   pnpm exec tsx crates/xtask/tests/golden/record-bulk-notes.ts
 *
 * It overwrites `bulk-notes.json` next to this file. Deleted with the TypeScript seeds in
 * Step 43 (#3560); the recorded file stays the contract.
 */

import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateBulkVault } from '../../../../apps/desktop/scripts/seed-data/bulk-notes'
import { writeNoteFiles } from '../../../../apps/desktop/scripts/seed-vault/file-writer'

const CASES = [
  { seed: 42, count: 1000, first: 1000 },
  { seed: 7, count: 50, first: 50 },
  { seed: 42, count: 10000, first: 100 }
]

const cases = CASES.map(({ seed, count, first }) => {
  const notes = generateBulkVault(count, seed).notes.slice(0, first)
  const dir = mkdtempSync(join(tmpdir(), 'bulk-notes-'))
  try {
    writeNoteFiles(
      dir,
      notes.map((note) => note.file)
    )
    // One `<sha256>  <path>` line per file, as `sha256sum` prints it.
    const files = notes.map((note) => {
      const hash = createHash('sha256').update(readFileSync(join(dir, note.path)))
      return `${hash.digest('hex')}  ${note.path}`
    })
    return { seed, count, first, files }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

writeFileSync(
  new URL('./bulk-notes.json', import.meta.url),
  JSON.stringify({ cases }, null, 2) + '\n',
  'utf8'
)
