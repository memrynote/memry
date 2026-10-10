import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The seam: right after the outside-vault check resolves a note file, the file
// is swapped for a link to a file outside the vault, before it is read or chmodded.
const race = vi.hoisted(() => ({ target: '', swap: (): void => {} }))

function swapOnce(probe: unknown): void {
  if (race.target === '' || probe !== race.target) return
  race.target = ''
  race.swap()
}

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  const realpath = async (probe: string): Promise<string> => {
    const real = await actual.realpath(probe)
    swapOnce(probe)
    return real
  }
  return { ...actual, default: { ...actual, realpath }, realpath }
})
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const native = (probe: string): string => {
    const real = actual.realpathSync.native(probe)
    swapOnce(probe)
    return real
  }
  const realpathSync = Object.assign((probe: string) => actual.realpathSync(probe), { native })
  return { ...actual, default: { ...actual, realpathSync }, realpathSync }
})

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

describe('a note file swapped for an outside link after the vault check (#3058)', () => {
  let outside: string

  beforeEach(() => {
    state.vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memry-swap-vault-')))
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-swap-outside-'))
    const secret = path.join(outside, 'private.md')
    fs.writeFileSync(secret, '- [ ] Outside secret {task:outside-task}\n')
    fs.mkdirSync(path.join(state.vault, 'notes'))
    const note = path.join(state.vault, 'notes', 'a.md')
    fs.writeFileSync(note, '- [ ] Mine {task:own-task}\n')
    race.target = note
    race.swap = () => {
      fs.rmSync(note)
      fs.symlinkSync(secret, note)
    }
  })

  afterEach(() => {
    race.target = ''
    fs.rmSync(state.vault, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  it.skipIf(process.platform === 'win32')(
    'carried tasks read nothing from the outside file',
    async () => {
      const ids = await getCarriedTaskIds({ noteIds: ['a'], folderPaths: [] })
      expect(ids).not.toContain('outside-task')
    }
  )
})
