// The note or journal day a vault file is, in the running app (Steps 13d and 13m, #3530). The
// test vault's markdown files become notes when it opens, and its journal file the day it names
// (`j2025-01-01`); a relaunch names nothing again, a rename made while the app was closed keeps
// the note, and a file removed outside the app takes its note's row with it.
import { renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { isAlive } from '../../harness/app-process'
import { invokeTest } from '../../harness/invoke-test'
import { restart } from '../../harness/tauri-lifecycle'
import { test, expect } from '../../harness/test'
import { pollUntil } from '../../harness/wait'

interface NoteFile {
  noteId: string
  path: string
  contentHash: string | null
}

type App = Parameters<typeof invokeTest>[0] & { pid: number }

const NOTES = ['notes/getting-started.md', 'notes/sample-project.md']
const DAY = 'journal/2025-01-01.md'

/** The rows once every path in `paths` has a row whose file is in its note. */
async function namedRows(app: App, paths: string[]): Promise<NoteFile[]> {
  const named = await pollUntil(
    async () => {
      const rows = await invokeTest<NoteFile[]>(app, 'e2e_vault_note_files')
      const all = paths.every((path) =>
        rows.some((row) => row.path === path && row.contentHash !== null)
      )
      return all ? rows : undefined
    },
    { timeoutMs: 20_000 }
  )
  expect(named).toBeDefined()
  return named as NoteFile[]
}

const idOf = (rows: NoteFile[], path: string): string | undefined =>
  rows.find((row) => row.path === path)?.noteId

test('the vault files become notes once, and a rename made while closed keeps the note', async ({
  app,
  testVaultPath
}) => {
  const opened = await namedRows(app, [DAY, ...NOTES])
  expect(opened.map((row) => row.path).toSorted()).toEqual([DAY, ...NOTES])
  expect(idOf(opened, DAY)).toBe('j2025-01-01')
  const ids = NOTES.map((path) => idOf(opened, path))

  await invokeTest(app, 'e2e_request_quit')
  expect(await pollUntil(() => !isAlive(app.pid), { timeoutMs: 15_000, intervalMs: 50 })).toBe(true)
  renameSync(
    join(testVaultPath, 'notes/sample-project.md'),
    join(testVaultPath, 'notes/renamed-project.md')
  )
  await restart(app)

  const reopened = await namedRows(app, [
    DAY,
    'notes/getting-started.md',
    'notes/renamed-project.md'
  ])
  expect(reopened).toHaveLength(3)
  expect(idOf(reopened, DAY)).toBe('j2025-01-01')
  expect(idOf(reopened, 'notes/getting-started.md')).toBe(ids[0])
  expect(idOf(reopened, 'notes/renamed-project.md')).toBe(ids[1])
})

test('a file removed outside the app takes its row with it', async ({ app, testVaultPath }) => {
  await namedRows(app, [DAY, ...NOTES])
  unlinkSync(join(testVaultPath, 'notes/getting-started.md'))
  const left = await pollUntil(
    async () => {
      const rows = await invokeTest<NoteFile[]>(app, 'e2e_vault_note_files')
      return rows.some((row) => row.path === 'notes/getting-started.md') ? undefined : rows
    },
    { timeoutMs: 20_000 }
  )
  expect(left?.map((row) => row.path).toSorted()).toEqual([DAY, 'notes/sample-project.md'])
})
