import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ vault: '' }))
const crdt = vi.hoisted(() => ({ feed: vi.fn() }))

vi.mock('@main/database/queries/notes', () => ({
  getNoteCacheById: (_db: unknown, id: string) => ({
    id,
    path: `notes/${id}.md`,
    title: id,
    createdAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-01T00:00:00.000Z',
    localOnly: false,
    emoji: null
  })
}))
vi.mock('../database', () => ({ getIndexDatabase: () => ({}) }))
vi.mock('../sync/crdt-provider', () => ({ getCrdtProvider: () => ({ getDoc: () => undefined }) }))
vi.mock('../sync/crdt-writeback', () => ({ markWritebackIgnored: vi.fn() }))
vi.mock('../sync/crdt-external-feed', () => ({ feedExternalEditToCrdt: crdt.feed }))
vi.mock('../vault/note-sync', () => ({ syncNoteToCache: () => ({ wordCount: 0 }) }))
vi.mock('../vault/notes-io', () => ({
  emitNoteEvent: vi.fn(),
  getVaultRoot: () => state.vault,
  toAbsolutePath: (p: string) => path.join(state.vault, p)
}))
vi.mock('../vault-locks/registry', () => ({ isNoteLocked: () => false }))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn() }))

import { removeTaskLineFromSourceNote } from './remove-task-line-from-note'

const SECRET = '- [ ] Outside secret {task:task-1}\nPrivate line\n'

describe('task delete and a source note file linked outside the vault (#2969)', () => {
  let outside: string
  let secret: string
  let link: string

  beforeEach(() => {
    state.vault = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-task-line-vault-'))
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-task-line-outside-'))
    secret = path.join(outside, 'private.md')
    fs.writeFileSync(secret, SECRET)
    fs.mkdirSync(path.join(state.vault, 'notes'))
    link = path.join(state.vault, 'notes', 'note-a.md')
    fs.symlinkSync(secret, link)
  })

  afterEach(() => {
    fs.rmSync(state.vault, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  it('leaves the link and the outside file alone and feeds nothing to the CRDT', async () => {
    await removeTaskLineFromSourceNote('task-1', 'note-a')

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(secret, 'utf-8')).toBe(SECRET)
    expect(fs.readdirSync(path.join(state.vault, 'notes'))).toEqual(['note-a.md'])
    expect(crdt.feed).not.toHaveBeenCalled()
  })
})
