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
vi.mock('../database', () => ({
  getDatabase: () => ({}),
  getIndexDatabase: () => ({}),
  isDatabaseInitialized: () => false,
  isIndexDatabaseInitialized: () => false
}))
vi.mock('../vault/index', () => ({ getStatus: () => ({ path: state.vault }) }))

import { setFileReadOnly, setFileReadOnlySync } from './files'

const isWindows = process.platform === 'win32'

describe('a note file swapped for an outside link after the vault check (#3058)', () => {
  let outside: string
  let secret: string
  let note: string

  beforeEach(() => {
    state.vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memry-swap-vault-')))
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-swap-outside-'))
    secret = path.join(outside, 'private.md')
    fs.writeFileSync(secret, 'outside secret\n')
    fs.chmodSync(secret, 0o640)
    fs.mkdirSync(path.join(state.vault, 'notes'))
    note = path.join(state.vault, 'notes', 'a.md')
    fs.writeFileSync(note, 'vault text\n')
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

  it.skipIf(isWindows)('lock chmod leaves the outside file mode alone', async () => {
    await setFileReadOnly(note, true)
    expect(fs.lstatSync(note).isSymbolicLink()).toBe(true)
    expect(fs.statSync(secret).mode & 0o777).toBe(0o640)
  })

  it.skipIf(isWindows)('sync lock chmod leaves the outside file mode alone', () => {
    setFileReadOnlySync(note, true)
    expect(fs.lstatSync(note).isSymbolicLink()).toBe(true)
    expect(fs.statSync(secret).mode & 0o777).toBe(0o640)
  })
})
