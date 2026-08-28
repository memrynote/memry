import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createFolder,
  createNoteInFolder,
  deleteFolder,
  duplicateFolder,
  folderName,
  isUnder,
  joinPath,
  moveFolder,
  parentPath,
  readFolderPaths,
  renameFolder,
  siblingNames,
  uniqueName
} from '@/features/notes/folder-ops'
import { duplicateTitle } from '@/features/notes/note-ops'
import { buildFolderTree, findFolder } from '@/features/notes/tree'

import { openTestVault, seedNote, type TestVault } from './vault-db-harness'

describe('path helpers', () => {
  it('splits a path into leaf and parent', () => {
    expect(folderName('Work/Interviews')).toBe('Interviews')
    expect(parentPath('Work/Interviews')).toBe('Work')
    expect(folderName('Work')).toBe('Work')
    expect(parentPath('Work')).toBe('')
    expect(joinPath('', 'Work')).toBe('Work')
    expect(joinPath('Work', 'Interviews')).toBe('Work/Interviews')
  })

  it('treats the root as containing everything and a sibling prefix as outside', () => {
    expect(isUnder('Work/Interviews', '')).toBe(true)
    expect(isUnder('Work/Interviews', 'Work')).toBe(true)
    expect(isUnder('Work', 'Work')).toBe(true)
    // The trap: `Workshop` starts with `Work` but is not inside it.
    expect(isUnder('Workshop/Notes', 'Work')).toBe(false)
  })

  it('picks the first free copy name', () => {
    expect(uniqueName(new Set(), 'Interviews')).toBe('Interviews copy')
    expect(uniqueName(new Set(['Interviews copy']), 'Interviews')).toBe('Interviews copy 2')
    expect(uniqueName(new Set(['Interviews copy', 'Interviews copy 2']), 'Interviews')).toBe(
      'Interviews copy 3'
    )
  })

  it('lists only DIRECT children as siblings', () => {
    const paths = ['Work', 'Work/Interviews', 'Work/Interviews/2026', 'Reading']
    expect([...siblingNames(paths, '')].sort()).toEqual(['Reading', 'Work'])
    expect([...siblingNames(paths, 'Work')]).toEqual(['Interviews'])
  })
})

describe('duplicateTitle', () => {
  it('keeps the extension on the end where every classifier looks for it', () => {
    expect(duplicateTitle('Weeknotes')).toBe('Weeknotes copy')
    expect(duplicateTitle('Roadmap 2026.pdf')).toBe('Roadmap 2026 copy.pdf')
    // A leading dot is a name, not an extension.
    expect(duplicateTitle('.hidden')).toBe('.hidden copy')
  })
})

describe('folder operations', () => {
  let vault: TestVault

  beforeEach(() => {
    vault = openTestVault()
  })
  afterEach(() => vault.close())

  it('createFolder makes an empty folder that the tree can draw and the queue will push', async () => {
    await createFolder(vault.ctx, 'Work/Interviews')

    expect([...(await readFolderPaths(vault.db))]).toEqual(['Work/Interviews'])

    const queued = vault.outboxRows()
    expect(queued).toHaveLength(1)
    expect(queued[0].itemType).toBe('folder_config:update')
    expect(queued[0].itemId).toBe('Work/Interviews')
    // The payload desktop's handler reads: an icon (null here) and a clock
    // this device owns. That handler mkdirs the folder on the way to writing
    // `.folder.md`, which is what makes an empty folder exist over there.
    expect(queued[0].payload).toMatchObject({ icon: null, clock: { 'device-a': 1 } })

    // And the tree draws it even though no note names it.
    const tree = buildFolderTree([], new Map(), await readFolderPaths(vault.db))
    expect(findFolder(tree, 'Work/Interviews')).not.toBeNull()
  })

  it('createNoteInFolder materialises the folder before the note lands in it', async () => {
    await createNoteInFolder(vault.ctx, 'Work/Interviews')
    const queued = vault.outboxRows()
    expect(queued.map((row) => row.itemType)).toEqual(['folder_config:update', 'note:create'])
    expect(queued[1].payload).toMatchObject({ folderPath: 'Work/Interviews' })
  })

  it('renameFolder moves every note under it and retires the old config path', async () => {
    seedNote(vault, { id: 'n1', title: 'Aurelie', folderPath: 'Work/Interviews' })
    seedNote(vault, { id: 'n2', title: 'Deep dive', folderPath: 'Work/Interviews/2026' })
    seedNote(vault, { id: 'n3', title: 'Elsewhere', folderPath: 'Workshop' })
    await createFolder(vault.ctx, 'Work/Interviews/2026')

    const moved = await renameFolder(vault.ctx, 'Work/Interviews', 'Work/Chats')
    expect(moved).toBe(2)

    const notes = await vault.db.getAllAsync<{ id: string; payload: string }>(
      `SELECT id, payload FROM sync_items WHERE type = 'note' ORDER BY id`
    )
    const folders = notes.map(
      (row) => (JSON.parse(row.payload) as { folderPath: string }).folderPath
    )
    expect(folders).toEqual(['Work/Chats', 'Work/Chats/2026', 'Workshop'])

    expect([...(await readFolderPaths(vault.db))]).toEqual(['Work/Chats/2026'])
  })

  it('refuses to move a folder into its own subtree', async () => {
    seedNote(vault, { id: 'n1', title: 'Aurelie', folderPath: 'Work' })
    const moved = await renameFolder(vault.ctx, 'Work', 'Work/Nested')
    expect(moved).toBe(0)
    const row = await vault.db.getFirstAsync<{ payload: string }>(
      `SELECT payload FROM sync_items WHERE id = 'n1'`
    )
    expect((JSON.parse(row!.payload) as { folderPath: string }).folderPath).toBe('Work')
  })

  it('moveFolder keeps the folder name and changes its parent', async () => {
    seedNote(vault, { id: 'n1', title: 'Aurelie', folderPath: 'Work/Interviews' })
    await moveFolder(vault.ctx, 'Work/Interviews', 'Reading')
    const row = await vault.db.getFirstAsync<{ payload: string }>(
      `SELECT payload FROM sync_items WHERE id = 'n1'`
    )
    expect((JSON.parse(row!.payload) as { folderPath: string }).folderPath).toBe(
      'Reading/Interviews'
    )
  })

  it('deleteFolder tombstones every note under it, notes before the folder itself', async () => {
    seedNote(vault, { id: 'n1', title: 'Aurelie', folderPath: 'Work/Interviews' })
    seedNote(vault, { id: 'n2', title: 'Keep me', folderPath: 'Reading' })
    await createFolder(vault.ctx, 'Work/Interviews')

    const result = await deleteFolder(vault.ctx, 'Work/Interviews')
    expect(result).toEqual({ notes: 1, folders: 1 })

    const live = await vault.db.getAllAsync<{ id: string }>(
      `SELECT id FROM sync_items WHERE type = 'note' AND deleted_at IS NULL`
    )
    expect(live.map((row) => row.id)).toEqual(['n2'])

    const deletes = vault.outboxRows().filter((row) => row.op === 'delete')
    // A peer applying the folder tombstone first would show an empty folder
    // for a moment; the reverse shows orphan notes inside a folder that is
    // already gone, which reads as data loss.
    expect(deletes.map((row) => row.itemType)).toEqual(['note:delete', 'folder_config:delete'])
  })

  it('duplicateFolder copies the subtree beside itself with new note ids', async () => {
    seedNote(vault, { id: 'n1', title: 'Aurelie', folderPath: 'Work/Interviews', markdown: '# hi' })
    seedNote(vault, { id: 'n2', title: 'Deep dive', folderPath: 'Work/Interviews/2026' })

    const destination = await duplicateFolder(vault.ctx, 'Work/Interviews')
    expect(destination).toBe('Work/Interviews copy')

    const notes = await vault.db.getAllAsync<{ id: string; payload: string }>(
      `SELECT id, payload FROM sync_items WHERE type = 'note' AND deleted_at IS NULL`
    )
    expect(notes).toHaveLength(4)
    const copies = notes
      .map(
        (row) => JSON.parse(row.payload) as { title: string; folderPath: string; content: string }
      )
      .filter((payload) => payload.folderPath.startsWith('Work/Interviews copy'))
      .sort((a, b) => a.folderPath.localeCompare(b.folderPath))
    // The body travels with the copy: `createNote`'s record payload carries it
    // once, and every later edit goes the CRDT path.
    expect(copies.find((copy) => copy.title === 'Aurelie')?.content).toBe('# hi')
    // Inside a copied folder the titles are already unique, so only the folder
    // is renamed.
    expect(copies.map((copy) => ({ title: copy.title, folderPath: copy.folderPath }))).toEqual([
      { title: 'Aurelie', folderPath: 'Work/Interviews copy' },
      { title: 'Deep dive', folderPath: 'Work/Interviews copy/2026' }
    ])
    // A copy that shared ids would be the same note in two places on the next
    // pull, which is the one way a duplicate can destroy the original.
    const ids = notes.map((row) => row.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('duplicateFolder takes the next free name when a copy already exists', async () => {
    seedNote(vault, { id: 'n1', title: 'Aurelie', folderPath: 'Interviews' })
    expect(await duplicateFolder(vault.ctx, 'Interviews')).toBe('Interviews copy')
    expect(await duplicateFolder(vault.ctx, 'Interviews')).toBe('Interviews copy 2')
  })
})
