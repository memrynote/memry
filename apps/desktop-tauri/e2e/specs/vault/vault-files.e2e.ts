// The files of a vault in the running app (Step 12, #3529). Port of the cases of
// `apps/desktop/tests/e2e/vault.e2e.ts` that assert files on disk: the folders and the config a
// new vault gets (T529) and an outside note found by the app (T531, whose reindex half is Step 13
// (#3530)). `vault.e2e.ts` here has the create, switch and error cases (Step 08). Every new
// markdown file is a note (Step 13d), and the `note_files` rows show what the watcher and the
// consumer made of each file.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { EXPECT_TIMEOUT_MS } from '../../harness/budgets'
import { invokeTest } from '../../harness/invoke-test'
import { gracefulClose, restart } from '../../harness/tauri-lifecycle'
import { removeDir } from '../../harness/remove-dir'
import { test, expect } from '../../harness/test'
import { invoke, type SelectResponse } from '../../harness/vault-commands'
import { pollUntil, readMainLog } from '../../harness/wait'

interface NoteFile {
  noteId: string
  path: string
  contentHash: string | null
}

interface VaultFile {
  text: string
  contentHash: string
}

type App = Parameters<typeof invokeTest>[0]

/**
 * The bytes Electron's `initVault` writes: `JSON.stringify(DEFAULT_CONFIG, null, 2)`, with
 * `DEFAULT_CONFIG` copied by hand from `apps/desktop/src/main/vault/init.ts`.
 */
const ELECTRON_INIT_CONFIG = JSON.stringify(
  {
    excludePatterns: ['.git', 'node_modules', '.trash', '.obsidian', '.memry'],
    defaultNoteFolder: '',
    journalFolder: 'journal',
    journalDateFormat: 'YYYY-MM-DD',
    attachmentsFolder: 'attachments',
    journalShowInSidebar: false
  },
  null,
  2
)

const rows = (app: App) => invokeTest<NoteFile[]>(app, 'e2e_vault_note_files')

/** The row of `rel` once it names text the note holds. */
async function rowOf(app: App, rel: string): Promise<NoteFile> {
  const row = await pollUntil(
    async () => (await rows(app)).find((file) => file.path === rel && file.contentHash !== null),
    { timeoutMs: EXPECT_TIMEOUT_MS }
  )
  if (!row) throw new Error(`no row for ${rel}`)
  return row
}

/** The row of `noteId` once `probe` holds for it. */
async function rowWhen(
  app: App,
  noteId: string,
  probe: (row: NoteFile | undefined) => boolean
): Promise<NoteFile | undefined> {
  let last: NoteFile | undefined
  const held = await pollUntil(
    async () => {
      last = (await rows(app)).find((file) => file.noteId === noteId)
      return probe(last)
    },
    { timeoutMs: EXPECT_TIMEOUT_MS }
  )
  if (!held) throw new Error(`the row of ${noteId} is still ${JSON.stringify(last)}`)
  return last
}

async function hashOf(app: App, rel: string): Promise<string> {
  const file = await invokeTest<VaultFile | null>(app, 'e2e_vault_read_file', { path: rel })
  if (!file) throw new Error(`${rel} is not in the vault`)
  return file.contentHash
}

/** What another program does: written, or saved atomically through a side file. */
function saveAtomically(path: string, text: string): void {
  const side = join(dirname(path), `.${basename(path)}.tmp`)
  writeFileSync(side, text)
  renameSync(side, path)
}

/** An error the vault file tier logged. */
const TIER_ERROR = /\[error\] \[vault_(watch|consumer|writeback)\]/

test('a vault opened in an empty folder gets the folders and the config Electron writes, and keeps an existing config', async ({
  page
}) => {
  const parent = join(mkdtempSync(join(tmpdir(), 'memry-e2e-parent-')), 'Fresh')
  mkdirSync(parent)
  try {
    const opened = await invoke<SelectResponse>(page, 'vault_select', { path: parent })
    expect(opened.success).toBe(true)
    const folders = ['journal', 'attachments', 'attachments/images', 'attachments/files']
    expect(folders.filter((folder) => !existsSync(join(parent, folder)))).toEqual([])
    const config = join(parent, '.memry', 'config.json')
    expect(readFileSync(config, 'utf8')).toBe(ELECTRON_INIT_CONFIG)
    if (process.platform !== 'win32') expect(statSync(config).mode & 0o777).toBe(0o600)

    // The next open does not write its defaults over a config the user or a newer build
    // wrote. `preferences` is left out: the settings of the opened vault mirror into it
    // (Step 09, #3526), at a moment of their own.
    writeFileSync(config, '{\n  "journalFolder": "diary",\n  "newerBuild": true\n}')
    await invoke(page, 'vault_close')
    expect((await invoke<SelectResponse>(page, 'vault_select', { path: parent })).success).toBe(
      true
    )
    const { preferences: _mirrored, ...kept } = JSON.parse(readFileSync(config, 'utf8')) as Record<
      string,
      unknown
    >
    expect(kept).toEqual({ journalFolder: 'diary', newerBuild: true })
  } finally {
    await invoke(page, 'vault_close').catch((error: unknown) => {
      console.warn('vault_close before cleanup failed', error)
    })
    removeDir(join(parent, '..'))
  }
})

test('files another program writes while the app runs reach their rows, and noise does not', async ({
  app,
  testVaultPath
}) => {
  const file = (rel: string) => join(testVaultPath, rel)

  // A new note: a row whose hash names the file's text.
  writeFileSync(file('notes/outside.md'), '# Outside\n\nwritten by another program\n')
  const added = await rowOf(app, 'notes/outside.md')
  expect(added.contentHash).toBe(await hashOf(app, 'notes/outside.md'))

  // An editor's atomic save (a side file renamed over the note) is a change of the same note.
  saveAtomically(file('notes/outside.md'), '# Outside\n\nsaved again, atomically\n')
  const saved = await hashOf(app, 'notes/outside.md')
  await rowWhen(app, added.noteId, (row) => row?.contentHash === saved)
  expect(
    await pollUntil(
      async () =>
        (await invokeTest<string>(app, 'e2e_note_body', { noteId: added.noteId })).includes(
          'saved again, atomically'
        ),
      { timeoutMs: EXPECT_TIMEOUT_MS }
    )
  ).toBe(true)

  // A move keeps the note.
  mkdirSync(file('notes/moved'), { recursive: true })
  renameSync(file('notes/outside.md'), file('notes/moved/outside.md'))
  await rowWhen(app, added.noteId, (row) => row?.path === 'notes/moved/outside.md')

  // Hidden files and the vault's own attachments folder are not notes; a deeper folder named
  // `attachments` is an ordinary folder.
  writeFileSync(file('notes/.hidden.md'), 'hidden\n')
  mkdirSync(file('attachments'), { recursive: true })
  writeFileSync(file('attachments/not-a-note.md'), 'an attachment\n')
  mkdirSync(file('notes/attachments'), { recursive: true })
  writeFileSync(file('notes/attachments/a-note.md'), 'a note\n')
  await rowOf(app, 'notes/attachments/a-note.md')
  const noise = new Set(['notes/.hidden.md', 'attachments/not-a-note.md'])
  const noiseRows = async () =>
    (await rows(app)).map((row) => row.path).filter((path) => noise.has(path))
  expect(await noiseRows()).toEqual([])

  // A delete of a file that held its whole note deletes the note (Step 13d), and its row goes.
  rmSync(file('notes/moved/outside.md'))
  await rowWhen(app, added.noteId, (row) => row === undefined)
  // Still no row for the noise, after everything since was taken in.
  expect(await noiseRows()).toEqual([])
  expect(readMainLog(app.dirs.logDir)).not.toMatch(TIER_ERROR)
})

test('files changed while the app was closed are found at the next open', async ({
  app,
  testVaultPath
}) => {
  const file = (rel: string) => join(testVaultPath, rel)
  writeFileSync(file('notes/to-move.md'), 'moved while closed\n')
  writeFileSync(file('notes/to-edit.md'), 'before the quit\n')
  const moving = await rowOf(app, 'notes/to-move.md')
  const editing = await rowOf(app, 'notes/to-edit.md')

  await gracefulClose(app)
  mkdirSync(file('notes/later'), { recursive: true })
  renameSync(file('notes/to-move.md'), file('notes/later/to-move.md'))
  writeFileSync(file('notes/to-edit.md'), 'edited while the app was closed\n')
  writeFileSync(file('notes/new-while-closed.md'), 'new while closed\n')
  await restart(app)

  await rowWhen(app, moving.noteId, (row) => row?.path === 'notes/later/to-move.md')
  await rowOf(app, 'notes/new-while-closed.md')
  const edited = await hashOf(app, 'notes/to-edit.md')
  await rowWhen(app, editing.noteId, (row) => row?.contentHash === edited)
  expect(await invokeTest<string>(app, 'e2e_note_body', { noteId: editing.noteId })).toBe(
    'edited while the app was closed'
  )
  expect(readMainLog(app.dirs.logDir)).not.toMatch(TIER_ERROR)
})
