/**
 * Generates the note fold vector files by running Electron's fold engine
 * (`src/main/note-fold/`) in place as the oracle.
 *
 *   pnpm --filter @memry/desktop vectors:note-fold          # write the files
 *   pnpm --filter @memry/desktop vectors:note-fold:check    # regenerate in memory, diff, write nothing
 *
 * The files live in `packages/contracts/test-vectors/`. This generator sits in
 * `apps/desktop` because it imports the Electron engine, and `packages/` never
 * imports an app; contracts' `vectors:check` only proves the files are present.
 * Dates format in UTC, so a file is the same on every machine. The Rust port
 * (`crates/memry-desktop/src/fold/`) reproduces every case
 * (`crates/memry-desktop/tests/note_fold_*vectors.rs`).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildText } from './text'

export const NOTE_FOLD_ZONE = 'UTC'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const COMMITTED_DIR = resolve(appRoot, '../../packages/contracts/test-vectors')

interface VectorFile {
  path: string
  source: string
  note: string
  build: () => Record<string, unknown>
}

const FILES: VectorFile[] = [
  {
    path: 'note-fold-text.json',
    source: 'src/main/note-fold/{engine,engine-tokens}.ts',
    note: 'The fold text helpers: language, sentences, words and the inline tokens. Dates format in timeZone.',
    build: buildText
  }
]

function withZone<T>(tz: string, run: () => T): T {
  const previous = process.env.TZ
  process.env.TZ = tz
  try {
    return run()
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
}

function render(file: VectorFile): string {
  const document = {
    meta: {
      spec: 'tauri-v2-3531-note-fold',
      oracle: `apps/desktop/scripts/note-fold-oracle (Electron fold engine run in place: ${file.source})`,
      note: file.note
    },
    timeZone: NOTE_FOLD_ZONE,
    ...withZone(NOTE_FOLD_ZONE, file.build)
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

function main(): void {
  const check = process.argv.includes('--check')
  const drifted: string[] = []
  for (const file of FILES) {
    const path = join(COMMITTED_DIR, file.path)
    const fresh = render(file)
    if (!check) {
      writeFileSync(path, fresh, 'utf8')
      process.stdout.write(`wrote ${path}\n`)
      continue
    }
    let committed = ''
    try {
      committed = readFileSync(path, 'utf8')
    } catch {
      drifted.push(`${file.path}: missing`)
      continue
    }
    if (committed !== fresh) drifted.push(`${file.path}: regenerates differently`)
  }
  if (drifted.length > 0) {
    process.stderr.write(
      `vectors:note-fold:check failed:\n${drifted.map((d) => `  ${d}\n`).join('')}` +
        'Regenerate with `pnpm --filter @memry/desktop vectors:note-fold`.\n'
    )
    process.exit(1)
  }
  if (check) process.stdout.write(`vectors:note-fold:check passed (${FILES.length} files)\n`)
}

main()
