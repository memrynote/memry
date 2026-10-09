import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ vault: '' }))

vi.mock('@main/database/queries/tasks', () => ({
  getTaskById: (_db: unknown, id: string) => ({ id }),
  getTaskNoteIds: () => []
}))
vi.mock('@main/database/queries/notes', () => ({
  getNoteCacheById: (_db: unknown, id: string) => ({ id, path: `notes/${id}.md` }),
  listNoteCacheUnderFolder: () => [],
  noteCacheExists: () => true
}))
vi.mock('../database', () => ({
  getDatabase: () => ({}),
  getIndexDatabase: () => ({}),
  isDatabaseInitialized: () => true
}))
vi.mock('../vault/notes-io', () => ({
  getVaultRoot: () => state.vault,
  toAbsolutePath: (p: string) => path.join(state.vault, p)
}))

import { getCarriedTaskIds } from './note-carried-tasks'

describe('note delete and a note file linked outside the vault (#2995)', () => {
  let outside: string

  beforeEach(() => {
    state.vault = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-carried-vault-'))
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-carried-outside-'))
    fs.mkdirSync(path.join(state.vault, 'notes'))
    const secret = path.join(outside, 'private.md')
    fs.writeFileSync(secret, '- [ ] Outside secret {task:outside-task}\n')
    fs.symlinkSync(secret, path.join(state.vault, 'notes', 'linked.md'))
    fs.writeFileSync(path.join(state.vault, 'notes', 'plain.md'), '- [ ] Mine {task:own-task}\n')
  })

  afterEach(() => {
    fs.rmSync(state.vault, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  it('adds no task ids from the outside file and keeps the ones in vault notes', async () => {
    const ids = await getCarriedTaskIds({ noteIds: ['linked', 'plain'], folderPaths: [] })
    expect(ids).toEqual(['own-task'])
  })
})
