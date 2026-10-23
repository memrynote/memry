/**
 * Home board covers through the IPC handlers, on a real data DB and a real
 * vault folder. Only the sync transport (`getCanvasAssetIO`) is faked: it is
 * the shared attachment queue, proven by its own suites.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDataDb, type TestDataDb } from '../../test/helpers/test-data-db'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  net: { fetch: vi.fn() }
}))

const vault = vi.hoisted(() => ({ path: '' }))
vi.mock('../vault/index', () => ({ getStatus: () => ({ path: vault.path }) }))

const io = vi.hoisted(() => ({
  uploadAttachment: vi.fn(),
  downloadAttachment: vi.fn()
}))
vi.mock('../ipc/sync-attachment-handlers', () => ({ getCanvasAssetIO: () => io }))

const syncUpdate = vi.hoisted(() => vi.fn())
vi.mock('./runtime-effects', () => ({
  enqueueHomePageCreate: vi.fn(),
  enqueueHomePageUpdate: syncUpdate,
  enqueueHomePageDelete: vi.fn()
}))
vi.mock('../lib/window-broadcast', () => ({ broadcastToAllWindows: vi.fn() }))

import { makeHomePageHandlers } from '../ipc/home-page-handlers'
import { updateHomePage } from './store'

const ATTACHMENT_ID = '0123456789abcdef0123456789abcdef'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).buffer

let db: TestDataDb
let h: ReturnType<typeof makeHomePageHandlers>

const coverFolder = (boardId: string) => path.join(vault.path, '.memry', 'home-covers', boardId)

beforeEach(() => {
  vault.path = mkdtempSync(path.join(tmpdir(), 'home-cover-'))
  db = createTestDataDb()
  h = makeHomePageHandlers(db)
  io.uploadAttachment.mockReset().mockResolvedValue({ attachmentId: ATTACHMENT_ID })
  io.downloadAttachment.mockReset().mockResolvedValue(undefined)
  syncUpdate.mockClear()
})

afterEach(() => {
  rmSync(vault.path, { recursive: true, force: true })
})

describe('home board covers', () => {
  it('stores an uploaded image in the board folder, syncs its bytes, and drops it for a wash', async () => {
    const board = await h.create({ name: 'Work', position: 0, widgets: [] })

    const result = await h.setCover({
      id: board.id,
      source: { kind: 'upload', filename: 'sky.png', data: PNG }
    })

    expect(result.ok).toBe(true)
    const ref = result.ok ? result.page.cover?.ref : undefined
    expect(ref).toMatch(new RegExp(`^\\.memry/home-covers/${board.id}/[^/]+-sky\\.png$`))
    const file = path.join(vault.path, ...ref!.split('/'))
    expect(existsSync(file)).toBe(true)

    await vi.waitFor(async () => {
      expect((await h.get(board.id))?.cover?.attachmentId).toBe(ATTACHMENT_ID)
    })
    expect(io.uploadAttachment).toHaveBeenCalledWith(board.id, file)
    // Once for the cover, once more when its attachment id is known.
    expect(syncUpdate).toHaveBeenCalledTimes(2)

    const wash = await h.setCover({ id: board.id, source: { kind: 'wash', id: 'sage' } })
    expect(wash.ok && wash.page.cover).toEqual({ ref: 'wash:sage' })
    expect(readdirSync(coverFolder(board.id))).toEqual([])
  })

  it('retries an upload that could not run, then downloads a synced cover to exactly its ref', async () => {
    const board = await h.create({ name: 'Work', position: 0, widgets: [] })
    io.uploadAttachment.mockRejectedValueOnce(new Error('offline'))
    const result = await h.setCover({
      id: board.id,
      source: { kind: 'upload', filename: 'sky.png', data: PNG }
    })
    const ref = result.ok ? result.page.cover!.ref : ''
    await vi.waitFor(() => {
      expect(io.uploadAttachment).toHaveBeenCalledTimes(1)
    })
    expect((await h.get(board.id))?.cover?.attachmentId).toBeUndefined()

    await h.materializeCover(board.id)
    expect((await h.get(board.id))?.cover?.attachmentId).toBe(ATTACHMENT_ID)

    // Another device: the row arrived by sync, the bytes did not.
    rmSync(coverFolder(board.id), { recursive: true })
    await h.materializeCover(board.id)
    expect(io.downloadAttachment).toHaveBeenCalledWith(
      ATTACHMENT_ID,
      path.join(vault.path, ...ref.split('/'))
    )
  })

  it('never downloads a synced ref that points outside its own board folder', async () => {
    const board = await h.create({ name: 'Work', position: 0, widgets: [] })
    for (const ref of [
      `.memry/home-covers/${board.id}/../../../notes/escape.png`,
      '.memry/home-covers/other-board/sky.png',
      'attachments/note-1/sky.png'
    ]) {
      updateHomePage(db, board.id, {
        cover: { ref, attachmentId: ATTACHMENT_ID }
      })
      await h.materializeCover(board.id)
    }

    expect(io.downloadAttachment).not.toHaveBeenCalled()
  })

  it('deletes the cover folder with the board', async () => {
    const board = await h.create({ name: 'Work', position: 0, widgets: [] })
    await h.setCover({ id: board.id, source: { kind: 'upload', filename: 'sky.png', data: PNG } })
    expect(existsSync(coverFolder(board.id))).toBe(true)

    await h.delete(board.id)

    expect(existsSync(coverFolder(board.id))).toBe(false)
  })
})
