import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  addBookmark,
  dropFolderBookmarks,
  readBookmarkKeys,
  removeBookmark,
  rewriteFolderBookmarks,
  toggleBookmark
} from '@/features/notes/bookmarks'
import { renameFolder } from '@/features/notes/folder-ops'

import { openTestVault, seedNote, type TestVault } from './vault-db-harness'

describe('bookmarks', () => {
  let vault: TestVault

  beforeEach(() => {
    vault = openTestVault()
  })
  afterEach(() => vault.close())

  it('derives the id from the pair so two devices mint the same row', async () => {
    await addBookmark(vault.ctx, 'note', 'n1')
    const queued = vault.outboxRows()
    expect(queued).toHaveLength(1)
    expect(queued[0].itemId).toBe('bmk_note_n1')
    expect(queued[0].itemType).toBe('bookmark:update')
    expect(queued[0].payload).toMatchObject({ itemType: 'note', itemId: 'n1', position: 0 })
  })

  it('reads back as a type:id key the tree can ask about', async () => {
    await addBookmark(vault.ctx, 'note', 'n1')
    await addBookmark(vault.ctx, 'folder', 'Work/Interviews')
    expect([...(await readBookmarkKeys(vault.db))].sort()).toEqual([
      'folder:Work/Interviews',
      'note:n1'
    ])
  })

  it('removes with a tombstone, not a row deletion', async () => {
    await addBookmark(vault.ctx, 'note', 'n1')
    await removeBookmark(vault.ctx, 'note', 'n1')

    const row = await vault.db.getFirstAsync<{ deleted_at: number | null }>(
      `SELECT deleted_at FROM sync_items WHERE id = 'bmk_note_n1'`
    )
    // A hard delete here would make the next pull treat the server's copy as
    // new and the bookmark would come back.
    expect(row?.deleted_at).not.toBeNull()
    expect(await readBookmarkKeys(vault.db)).toEqual(new Set())
    expect(vault.outboxRows().at(-1)?.itemType).toBe('bookmark:delete')
  })

  it('re-adding after a removal keeps the clock climbing', async () => {
    await addBookmark(vault.ctx, 'note', 'n1')
    await removeBookmark(vault.ctx, 'note', 'n1')
    await addBookmark(vault.ctx, 'note', 'n1')

    // One row, not three: `enqueueRecord` supersedes this device's earlier
    // pending rows for the same id, because each carries the whole payload as
    // it stands and an older one says nothing the newest does not.
    const rows = vault.outboxRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].itemType).toBe('bookmark:update')
    expect((rows[0].payload as { clock: Record<string, number> }).clock['device-a']).toBe(3)
    // A fresh `{device-a: 1}` on the re-add would read as OLDER than the
    // delete on every peer, and the bookmark would simply never come back.
    expect(await readBookmarkKeys(vault.db)).toEqual(new Set(['note:n1']))
  })

  it('toggle takes the current state rather than re-reading it', async () => {
    await toggleBookmark(vault.ctx, 'note', 'n1', false)
    expect(await readBookmarkKeys(vault.db)).toEqual(new Set(['note:n1']))
    await toggleBookmark(vault.ctx, 'note', 'n1', true)
    expect(await readBookmarkKeys(vault.db)).toEqual(new Set())
  })

  it('a folder bookmark follows the folder through a rename', async () => {
    seedNote(vault, { id: 'n1', title: 'Aurelie', folderPath: 'Work/Interviews' })
    await addBookmark(vault.ctx, 'folder', 'Work/Interviews')

    await renameFolder(vault.ctx, 'Work/Interviews', 'Work/Chats')

    // The id is derived from the path, so the row cannot be updated in place:
    // the old one is retired and a new one takes its place.
    expect(await readBookmarkKeys(vault.db)).toEqual(new Set(['folder:Work/Chats']))
  })

  it('rewrite leaves a sibling whose name merely starts the same alone', async () => {
    await addBookmark(vault.ctx, 'folder', 'Workshop')
    await rewriteFolderBookmarks(vault.ctx, 'Work', 'Office')
    expect(await readBookmarkKeys(vault.db)).toEqual(new Set(['folder:Workshop']))
  })

  it('dropping a folder takes its descendants bookmarks with it', async () => {
    await addBookmark(vault.ctx, 'folder', 'Work')
    await addBookmark(vault.ctx, 'folder', 'Work/Interviews')
    await addBookmark(vault.ctx, 'folder', 'Reading')

    await dropFolderBookmarks(vault.ctx, 'Work')
    expect(await readBookmarkKeys(vault.db)).toEqual(new Set(['folder:Reading']))
  })
})
