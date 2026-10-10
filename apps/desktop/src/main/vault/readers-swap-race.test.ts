import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The seam: right after the outside-vault check resolves a note file, the file
// is swapped for a link to a file outside the vault, before it is read.
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

const state = vi.hoisted(() => ({ vault: '', snapshots: [] as string[] }))
vi.mock('@main/database/queries/notes', () => ({
  getNoteCacheById: (_db: unknown, id: string) => ({ id, path: `notes/${id}.md`, title: id }),
  snapshotExistsWithHash: () => false,
  getLatestSnapshot: () => null,
  insertNoteSnapshot: (_db: unknown, row: { fileContent: string }) => {
    state.snapshots.push(row.fileContent)
    return { ...row, createdAt: new Date().toISOString() }
  },
  pruneOldSnapshots: () => undefined
}))
vi.mock('../database', () => ({
  getDatabase: () => ({}),
  getIndexDatabase: () => ({}),
  isDatabaseInitialized: () => true
}))
vi.mock('./notes-io', () => ({
  emitNoteEvent: () => undefined,
  getVaultRoot: () => state.vault,
  toAbsolutePath: (p: string) => path.join(state.vault, p)
}))
vi.mock('./index', () => ({
  getStatus: () => ({ path: state.vault }),
  getConfig: () => ({
    defaultNoteFolder: 'notes',
    journalFolder: 'journal',
    journalDateFormat: 'YYYY-MM-DD'
  })
}))

import { createCloseSnapshot } from './notes-versions'
import { readJournalTextSync } from './journal'
import { OutsideVaultError } from '../lib/errors'

const isWindows = process.platform === 'win32'

describe('a vault file swapped for an outside link after the vault check (#3074)', () => {
  let outside: string
  let secret: string

  function arm(file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'vault text\n')
    race.target = file
    race.swap = () => {
      fs.rmSync(file)
      fs.symlinkSync(secret, file)
    }
  }

  beforeEach(() => {
    state.vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memry-swap-vault-')))
    state.snapshots = []
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-swap-outside-'))
    secret = path.join(outside, 'private.md')
    fs.writeFileSync(secret, 'outside secret\n')
  })

  afterEach(() => {
    race.target = ''
    fs.rmSync(state.vault, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  it.skipIf(isWindows)('a close snapshot never holds the outside bytes', async () => {
    arm(path.join(state.vault, 'notes', 'a.md'))
    await createCloseSnapshot('a').catch(() => false)
    expect(state.snapshots.join('')).not.toContain('outside secret')
  })

  it.skipIf(isWindows)('the sync journal read never returns the outside bytes', () => {
    arm(path.join(state.vault, 'journal', '2024-01-02.md'))
    expect(() => readJournalTextSync('2024-01-02')).toThrow(OutsideVaultError)
  })
})
