// Captures the Electron-written vault of the Tauri note identity tests (Step 13d, #3530):
// crates/memry-desktop/tests/fixtures/electron-vault plus electron-vault.notes.json.
//
//   pnpm install                           (repo root)
//   pnpm --filter @memry/desktop rebuild:node
//   node scripts/electron-fixtures/capture-vault.mjs
//
// Electron's own `createNote` makes five notes (a sanitized title, two notes titled the same in
// one folder, one with frontmatter), its own indexer finds three files written outside it (one
// at the root, one in the journal folder), and `buildNotePushPayload` gives each note's push
// payload. The vault, its `data.db` and `index.db` (gzipped) and the payloads are written to the
// fixture. The ids are random, so a capture replaces the whole fixture.
//
// The capture runs under the desktop app's vitest config, so it writes its test into
// apps/desktop/src/main/vault for the run and removes it after.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
const desktop = path.join(root, 'apps/desktop')
const testFile = path.join(desktop, 'src/main/vault/electron-vault-fixture.capture.test.ts')
const out = path.join(root, 'crates/memry-desktop/tests/fixtures/electron-vault')

const TEST = `/**
 * Writes the Electron-written vault of the Tauri note identity tests
 * (\`crates/memry-desktop/tests/fixtures/electron-vault\`, Step 13d #3530): notes made by
 * Electron's own \`createNote\` and files found by its own indexer, with the \`data.db\` and
 * \`index.db\` it wrote (gzipped) and each note's push payload (\`buildNotePushPayload\`).
 * Runs only with \`MEMRY_ELECTRON_VAULT_OUT=<dir>\`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { gzipSync } from 'zlib'
import { createTestVault, type TestVaultResult } from '@tests/utils/test-vault'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import type { VaultConfig } from '@memry/contracts/vault-api'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import { startProjectionRuntime, stopProjectionRuntime } from '../projections'
import type * as DatabaseModule from '../database'

const OUT = process.env.MEMRY_ELECTRON_VAULT_OUT
const state = vi.hoisted(() => ({ vault: '' }))

vi.mock('electron', () => {
  const mockWindow = { isDestroyed: () => false, webContents: { send: () => undefined } }
  return {
    BrowserWindow: { getAllWindows: () => [mockWindow] },
    shell: { openPath: () => Promise.resolve(''), showItemInFolder: () => undefined }
  }
})
vi.mock('./status', async () => await import('./index'))
vi.mock('./index', () => ({
  getConfig: (): VaultConfig => ({
    excludePatterns: ['.git', 'node_modules', '.trash'],
    defaultNoteFolder: 'notes',
    journalFolder: 'journal',
    journalDateFormat: 'YYYY-MM-DD',
    attachmentsFolder: 'attachments'
  }),
  getStatus: () => ({
    isOpen: true,
    path: state.vault,
    isIndexing: false,
    indexProgress: 100,
    error: null
  }),
  getVaultPath: () => state.vault,
  emitIndexProgress: () => undefined
}))
vi.mock('../inbox/suggestions', () => ({ updateNoteEmbedding: () => Promise.resolve() }))
vi.mock('../tasks/reconcile-markdown-tasks', () => ({
  reconcileTaskCheckboxesFromMarkdown: async () => 0
}))
vi.mock('../sync/crdt-external-feed', () => ({ feedExternalEditToCrdt: async () => false }))

describe.skipIf(!OUT)('electron vault fixture', () => {
  let vault: TestVaultResult
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult

  beforeAll(async () => {
    vault = createTestVault('electron-vault-fixture')
    state.vault = vault.path
    dataDb = createTestDataDb()
    indexDb = createTestIndexDb()
    const database: typeof DatabaseModule = await import('../database')
    vi.spyOn(database, 'getDatabase').mockReturnValue(asClientDb(dataDb.db))
    vi.spyOn(database, 'getIndexDatabase').mockReturnValue(indexDb.db)
    vi.spyOn(database, 'updateFtsContent').mockImplementation(() => undefined)
    const client = await import('../database/client')
    vi.spyOn(client, 'getDatabase').mockReturnValue(asClientDb(dataDb.db))
    vi.spyOn(client, 'getIndexDatabase').mockReturnValue(indexDb.db)
    startProjectionRuntime([createNoteDerivedStateProjector(() => vault.path)])
  })

  afterAll(async () => {
    await stopProjectionRuntime({ drain: true })
    vi.restoreAllMocks()
    indexDb.close()
    dataDb.close()
    vault.cleanup()
  })

  it('writes the vault', async () => {
    const { createNote } = await import('./notes')
    const { indexVault } = await import('./indexer')
    const { buildNotePushPayload } = await import(
      '../sync/item-handlers/note-handler-sync-helpers'
    )
    const at = (day: number): string => \`2025-01-0\${day}T10:00:00.000Z\`

    await createNote({ title: 'Getting Started', content: 'Welcome.\\n', created: at(1), modified: at(1) })
    await createNote({ title: 'Q3: plan?', content: 'Goals.\\n', created: at(2), modified: at(2) })
    await createNote({ title: 'Plan', folder: 'projects/2025', content: 'First.\\n', created: at(3), modified: at(3) })
    await createNote({ title: 'Plan', folder: 'projects/2025', content: 'Second.\\n', created: at(4), modified: at(4) })
    await createNote({
      title: 'Tagged',
      content: 'With frontmatter.\\n',
      tags: ['work'],
      properties: { status: 'draft' },
      created: at(5),
      modified: at(5)
    })
    fs.writeFileSync(path.join(vault.path, 'Inbox.md'), 'At the root.\\n')
    fs.writeFileSync(path.join(vault.notesDir, 'outside.md'), 'Written by another program.\\n')
    fs.writeFileSync(path.join(vault.journalDir, '2025-01-01.md'), 'A journal day.\\n')
    await indexVault(vault.path)
    await stopProjectionRuntime({ drain: true })

    const rows = dataDb.sqlite
      .prepare('SELECT id, path, title, file_type AS fileType FROM note_metadata ORDER BY path')
      .all() as Array<{ id: string; path: string; title: string; fileType: string }>
    expect(rows.map((row) => row.path)).toEqual([
      'Inbox.md',
      'journal/2025-01-01.md',
      'notes/Getting Started.md',
      'notes/Q3 plan.md',
      'notes/Tagged.md',
      'notes/outside.md',
      'projects/2025/Plan 1.md',
      'projects/2025/Plan.md'
    ])
    const notes = rows.map((row) => {
      const journalDay = /^j\\d{4}-\\d{2}-\\d{2}$/.test(row.id)
      const payload = journalDay ? null : buildNotePushPayload(row.id, 'create')
      return { ...row, payload: payload === null ? null : JSON.parse(payload) }
    })

    const out = OUT as string
    fs.rmSync(out, { recursive: true, force: true })
    fs.cpSync(vault.path, out, { recursive: true })
    fs.writeFileSync(path.join(out, '.memry', 'data.db.gz'), gzipSync(dataDb.sqlite.serialize()))
    fs.writeFileSync(path.join(out, '.memry', 'index.db.gz'), gzipSync(indexDb.sqlite.serialize()))
    fs.writeFileSync(path.join(out, '.gitattributes'), '* -text -whitespace\\n')
    fs.writeFileSync(
      path.join(path.dirname(out), 'electron-vault.notes.json'),
      \`\${JSON.stringify(notes, null, 2)}\\n\`
    )
  })
})
`

fs.writeFileSync(testFile, TEST)
try {
  const run = spawnSync(
    'pnpm',
    ['exec', 'vitest', 'run', '--config', 'config/vitest.config.ts', '--project', 'main', testFile],
    { cwd: desktop, stdio: 'inherit', env: { ...process.env, MEMRY_ELECTRON_VAULT_OUT: out } }
  )
  if (run.status !== 0) process.exit(run.status ?? 1)
} finally {
  fs.rmSync(testFile, { force: true })
}
