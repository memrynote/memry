import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { createNoteContentStore, type NoteContentStore, type VaultStoreLayout } from './note-content-store'

describe('createNoteContentStore', () => {
  let rootPath: string
  let layout: VaultStoreLayout
  let store: NoteContentStore

  beforeEach(async () => {
    rootPath = path.join(
      os.tmpdir(),
      `memry-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    )
    await fs.mkdir(rootPath, { recursive: true })
    layout = {
      rootPath,
      notesFolder: 'notes',
      journalFolder: 'journal'
    }
    store = createNoteContentStore(layout)
  })

  afterEach(async () => {
    await fs.rm(rootPath, { recursive: true, force: true })
  })

  describe('resolve', () => {
    it('joins root + relative path', () => {
      // #when
      const resolved = store.resolve('notes/hello.md')

      // #then
      expect(resolved).toBe(path.join(rootPath, 'notes/hello.md'))
    })
  })

  describe('write + read', () => {
    it('writes file and creates parent directories', async () => {
      // #when
      await store.write('notes/sub/deep/hello.md', 'hello world')

      // #then
      const contents = await fs.readFile(
        path.join(rootPath, 'notes/sub/deep/hello.md'),
        'utf-8'
      )
      expect(contents).toBe('hello world')
    })

    it('read returns written content', async () => {
      // #given
      await store.write('notes/hello.md', 'body')

      // #when
      const read = await store.read('notes/hello.md')

      // #then
      expect(read).toBe('body')
    })

    it('overwrites existing file on write', async () => {
      // #given
      await store.write('notes/hello.md', 'v1')

      // #when
      await store.write('notes/hello.md', 'v2')

      // #then
      expect(await store.read('notes/hello.md')).toBe('v2')
    })

    it('write uses tmp+rename (no .tmp residue on success)', async () => {
      // #when
      await store.write('notes/atomic.md', 'done')

      // #then
      const dir = await fs.readdir(path.join(rootPath, 'notes'))
      expect(dir).toContain('atomic.md')
      expect(dir.filter((f) => f.endsWith('.tmp'))).toHaveLength(0)
    })

    it('read returns null when file does not exist', async () => {
      // #when
      const value = await store.read('notes/missing.md')

      // #then
      expect(value).toBeNull()
    })
  })

  describe('exists', () => {
    it('returns true when file exists', async () => {
      // #given
      await store.write('notes/here.md', 'x')

      // #when / #then
      expect(await store.exists('notes/here.md')).toBe(true)
    })

    it('returns false when file missing', async () => {
      expect(await store.exists('notes/missing.md')).toBe(false)
    })
  })

  describe('remove', () => {
    it('deletes existing file and returns true', async () => {
      // #given
      await store.write('notes/gone.md', 'x')

      // #when
      const removed = await store.remove('notes/gone.md')

      // #then
      expect(removed).toBe(true)
      expect(await store.exists('notes/gone.md')).toBe(false)
    })

    it('returns false when file missing', async () => {
      // #when
      const removed = await store.remove('notes/nothing.md')

      // #then
      expect(removed).toBe(false)
    })
  })

  describe('getJournalRelativePath', () => {
    it('returns YYYY-MM-DD.md under journal folder', () => {
      // #when
      const p = store.getJournalRelativePath('2026-04-16')

      // #then
      expect(p).toBe('journal/2026-04-16.md')
    })

    it('uses forward slashes regardless of platform', () => {
      // #when
      const p = store.getJournalRelativePath('2026-04-16')

      // #then
      expect(p).not.toContain('\\')
    })

    it('respects custom journalFolder', () => {
      // #given
      const custom = createNoteContentStore({ ...layout, journalFolder: 'daily' })

      // #when
      const p = custom.getJournalRelativePath('2026-04-16')

      // #then
      expect(p).toBe('daily/2026-04-16.md')
    })
  })
})
