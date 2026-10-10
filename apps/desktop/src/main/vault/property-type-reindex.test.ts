import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The seam: right after the vault check resolves the note file, it is swapped
// for a link to a file outside the vault, before it is read.
const race = vi.hoisted(() => ({ target: '', swap: (): void => {} }))

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  const realpath = async (probe: string): Promise<string> => {
    const real = await actual.realpath(probe)
    if (race.target !== '' && probe === race.target) {
      race.target = ''
      race.swap()
    }
    return real
  }
  return { ...actual, default: { ...actual, realpath }, realpath }
})

const state = vi.hoisted(() => ({ retyped: [] as string[] }))
vi.mock('@main/database/queries/notes', () => ({
  listNotePropertyRowsByName: () => [{ noteId: 'p', type: 'date' }],
  getNoteCacheById: () => ({ id: 'p', path: 'notes/p.md', indexedAt: 't' }),
  getPropertyType: (_db: unknown, _name: string, value: unknown) =>
    value === 'outside secret' ? 'leaked' : 'text',
  setNotePropertyType: (_db: unknown, _id: string, _name: string, type: string) => {
    state.retyped.push(type)
  }
}))

import { retypeIndexedProperties } from './property-type-reindex'
import type { IndexDb } from '../database'

const db = {} as IndexDb
const isWindows = process.platform === 'win32'

describe('retypeIndexedProperties reads the note file it checked', () => {
  let vault: string
  let outside: string
  let file: string

  beforeEach(() => {
    vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memry-retype-vault-')))
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-retype-outside-'))
    file = path.join(vault, 'notes', 'p.md')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '---\nstatus: inside\n---\nbody\n')
    state.retyped = []
  })

  afterEach(() => {
    race.target = ''
    fs.rmSync(vault, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  it('re-types a row from the note file in the vault', async () => {
    expect(await retypeIndexedProperties(db, vault, ['status'])).toBe(1)
    expect(state.retyped).toEqual(['text'])
  })

  it.skipIf(isWindows)('never re-types from a file swapped for an outside link', async () => {
    const secret = path.join(outside, 'private.md')
    fs.writeFileSync(secret, '---\nstatus: outside secret\n---\n')
    race.target = file
    race.swap = () => {
      fs.rmSync(file)
      fs.symlinkSync(secret, file)
    }
    expect(await retypeIndexedProperties(db, vault, ['status'])).toBe(0)
    expect(state.retyped).toEqual([])
  })
})
