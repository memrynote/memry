// Captures the Electron-written journal day files of the Tauri write-back tests (Step 13m,
// #3530): crates/memry-desktop/tests/fixtures/electron-journal.
//
//   pnpm install                           (repo root)
//   node scripts/electron-fixtures/capture-journal.mjs
//
// Electron's own `buildJournalEntryWrite` (`vault/journal.ts`), the writer of its journal
// service and of its sync apply, writes each file: a new day with tags, aliases and
// properties; a tags update of a day an older build wrote (legacy `id`, `created`, `modified`
// keys and nested `properties`, which Electron edits in place); and a tags update of a day
// with CRLF line ends and a comment. The files replace the whole fixture.
//
// The capture runs under the desktop app's vitest config, so it writes its test into
// apps/desktop/src/main/vault for the run and removes it after.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
const desktop = path.join(root, 'apps/desktop')
const testFile = path.join(desktop, 'src/main/vault/electron-journal-fixture.capture.test.ts')
const out = path.join(root, 'crates/memry-desktop/tests/fixtures/electron-journal')

const TEST = `/**
 * Writes the Electron-written journal day files of the Tauri write-back tests
 * (\`crates/memry-desktop/tests/fixtures/electron-journal\`, Step 13m #3530) with Electron's
 * own \`buildJournalEntryWrite\`. Runs only with \`MEMRY_ELECTRON_JOURNAL_OUT=<dir>\`.
 */
import { describe, it, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const OUT = process.env.MEMRY_ELECTRON_JOURNAL_OUT
const state = vi.hoisted(() => ({ vault: '' }))

vi.mock('./status', () => ({
  getConfig: () => ({
    excludePatterns: ['.git', 'node_modules', '.trash'],
    defaultNoteFolder: 'notes',
    journalFolder: 'journal',
    journalDateFormat: 'YYYY-MM-DD',
    attachmentsFolder: 'attachments'
  }),
  getStatus: () => ({ isOpen: true, path: state.vault, isIndexing: false, indexProgress: 100, error: null })
}))

describe.skipIf(!OUT)('electron journal fixture', () => {
  state.vault = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-journal-'))
  const journal = path.join(state.vault, 'journal')
  fs.mkdirSync(journal, { recursive: true })
  afterAll(() => fs.rmSync(state.vault, { recursive: true, force: true }))

  it('writes the files', async () => {
    const { buildJournalEntryWrite } = await import('./journal')
    const files: Record<string, string> = {}
    const write = (name: string, date: string, ...rest: Parameters<typeof buildJournalEntryWrite> extends [string, ...infer R] ? R : never) => {
      const { fileContent } = buildJournalEntryWrite(date, ...rest)
      fs.writeFileSync(path.join(journal, date + '.md'), fileContent)
      files[name] = fileContent
    }

    write('created.md', '2025-01-14', 'First line of the day.\\n\\nA second paragraph.', ['work', 'Ideas'],
      { mood: 'calm', rating: 4, due: '2025-02-01' }, ['Tuesday'])

    fs.writeFileSync(path.join(journal, '2025-01-15.md'),
      "---\\nid: j2025-01-15\\ndate: '2025-01-15'\\ncreated: 2025-01-15T08:00:00.000Z\\nmodified: 2025-01-15T09:30:00.000Z\\ntags:\\n  - old\\nproperties:\\n  energy: high\\n---\\nAn entry an older build wrote.\\n")
    write('legacy.md', '2025-01-15', null, ['old', 'from-sync'])

    fs.writeFileSync(path.join(journal, '2025-01-16.md'),
      "---\\r\\ndate: '2025-01-16'\\r\\n# the author's comment\\r\\ntags: [plain]\\r\\nweather: \\"sunny\\"\\r\\n---\\r\\nWindows line ends.\\r\\n")
    write('crlf.md', '2025-01-16', null, ['plain', 'synced'])

    const out = OUT as string
    fs.rmSync(out, { recursive: true, force: true })
    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(path.join(out, '.gitattributes'), '* -text -whitespace\\n')
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(out, name), text)
  })
})
`

fs.writeFileSync(testFile, TEST)
try {
  const run = spawnSync(
    'pnpm',
    ['exec', 'vitest', 'run', '--config', 'config/vitest.config.ts', '--project', 'main', testFile],
    { cwd: desktop, stdio: 'inherit', env: { ...process.env, MEMRY_ELECTRON_JOURNAL_OUT: out } }
  )
  if (run.status !== 0) process.exitCode = run.status ?? 1
} finally {
  fs.rmSync(testFile, { force: true })
}
