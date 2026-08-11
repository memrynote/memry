import fs from 'node:fs'
import os from 'node:os'
import nodePath from 'node:path'
import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { canvasFolders, canvases } from '@memry/db-schema/data-schema'
import { canvasFolderSyncId } from '@memry/contracts/canvas-folder-types'
import { createTestDataDb, type TestDataDb } from '../../../test/helpers/test-data-db'
import type { SyncQueueManager } from '../queue'

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

// A folder is a real directory in the vault, so the delete path needs one to
// point at. Same shape as the canvas handler's suite.
const vaultDir = vi.hoisted(() => ({ current: '' }))
vi.mock('../../canvas/vault-path', () => ({
  getCanvasVaultPath: () => vaultDir.current || null
}))

// The two modules the ordering test drags in, and only for their side effects:
// `canvasHandler` GCs assets after a delete (electron-backed IO), and reconcile
// pushes a folder revival onto the sync queue (the process-wide database this
// suite never installs). Neither is what the test is about.
vi.mock('../../canvas/assets/asset-service-context', () => ({
  buildAssetServiceContext: vi.fn(() => null)
}))
vi.mock('../../canvas/assets/asset-service', () => ({
  ensureAssetsPresent: vi.fn(),
  reconcileCanvasAssets: vi.fn()
}))
vi.mock('../local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn()
}))

import { canvasFolderHandler } from './canvas-folder-handler'
import { canvasHandler } from './canvas-handler'
import { reconcileCanvasFiles } from '../../canvas/reconcile'
import { CANVAS_DIR, withCanvasMeta } from '../../canvas/scene-file'

const VAULT_ID = 'vault-1'

let db: TestDataDb
const emit = vi.fn()
const ctx = (): { db: TestDataDb; emit: typeof emit } => ({ db, emit })

function folderDir(...segments: string[]): string {
  return nodePath.join(vaultDir.current, 'canvases', ...segments)
}

function row(id: string): typeof canvasFolders.$inferSelect | undefined {
  return db.select().from(canvasFolders).where(eq(canvasFolders.id, id)).get()
}

function seedRow(
  values: Partial<typeof canvasFolders.$inferInsert> & { id: string }
): typeof canvasFolders.$inferSelect {
  db.insert(canvasFolders)
    .values({
      vaultId: VAULT_ID,
      path: 'Work',
      icon: null,
      createdAt: 1,
      updatedAt: 1,
      ...values
    })
    .run()
  return row(values.id)!
}

/** Kept apart from `vaultDir` so a test may close the vault and still clean up. */
let tempVault = ''

beforeEach(() => {
  db = createTestDataDb()
  emit.mockClear()
  tempVault = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'memry-canvas-folder-handler-'))
  vaultDir.current = tempVault
})

afterEach(() => {
  fs.rmSync(tempVault, { recursive: true, force: true })
})

describe('canvasFolderHandler', () => {
  it('inserts a folder that does not exist locally', () => {
    const result = canvasFolderHandler.applyUpsert(
      ctx(),
      'cvf_work',
      { vaultId: VAULT_ID, path: 'Work', icon: '📁' },
      { deviceA: 1 }
    )

    expect(result).toBe('applied')
    const inserted = row('cvf_work')
    expect(inserted?.path).toBe('Work')
    expect(inserted?.icon).toBe('📁')
    expect(inserted?.vaultId).toBe(VAULT_ID)
    expect(inserted?.clock).toEqual({ deviceA: 1 })
    // Timestamps are epoch ms integers (matching `canvases`), never ISO strings.
    expect(typeof inserted?.createdAt).toBe('number')
    expect(emit).toHaveBeenCalledWith('canvasFolder:created', expect.anything())
  })

  it('applies a remote update whose clock cleanly dominates the local one', () => {
    seedRow({ id: 'cvf_work', path: 'Work', icon: null, clock: { deviceA: 1 } })

    const result = canvasFolderHandler.applyUpsert(
      ctx(),
      'cvf_work',
      { vaultId: VAULT_ID, path: 'Work', icon: '🎨' },
      { deviceA: 3 }
    )

    expect(result).toBe('applied')
    expect(row('cvf_work')?.icon).toBe('🎨')
    expect(row('cvf_work')?.clock).toEqual({ deviceA: 3 })
    expect(emit).toHaveBeenCalledWith('canvasFolder:updated', expect.anything())
  })

  it('skips a remote update when the local clock is strictly newer', () => {
    seedRow({ id: 'cvf_work', path: 'Work', icon: '🎨', clock: { deviceA: 5 } })

    const result = canvasFolderHandler.applyUpsert(
      ctx(),
      'cvf_work',
      { vaultId: VAULT_ID, path: 'Stale', icon: '💀' },
      { deviceA: 2 }
    )

    expect(result).toBe('skipped')
    expect(row('cvf_work')?.path).toBe('Work')
    expect(row('cvf_work')?.icon).toBe('🎨')
  })

  it('reports a conflict on concurrent clocks and keeps the remote value', () => {
    seedRow({ id: 'cvf_work', path: 'Work', icon: '🎨', clock: { deviceA: 3 } })

    const result = canvasFolderHandler.applyUpsert(
      ctx(),
      'cvf_work',
      { vaultId: VAULT_ID, path: 'Work', icon: '🧭' },
      { deviceB: 4 }
    )

    expect(result).toBe('conflict')
    expect(row('cvf_work')?.icon).toBe('🧭')
    expect(row('cvf_work')?.clock).toEqual({ deviceA: 3, deviceB: 4 })
  })

  it('soft-deletes on delete rather than dropping the row', () => {
    seedRow({ id: 'cvf_work', path: 'Work', clock: { deviceA: 1 } })

    const result = canvasFolderHandler.applyDelete(ctx(), 'cvf_work', { deviceA: 2 })

    expect(result).toBe('applied')
    const tombstone = row('cvf_work')
    // The row has to survive: sync compares against the tombstone, and a hard
    // delete would let the next pull resurrect the folder.
    expect(tombstone).toBeDefined()
    expect(tombstone?.deletedAt).toBeTruthy()
    expect(tombstone?.clock).toEqual({ deviceA: 2 })
    expect(emit).toHaveBeenCalledWith('canvasFolder:deleted', expect.anything())
  })

  it('skips a remote delete when the local row has unseen changes', () => {
    seedRow({ id: 'cvf_work', path: 'Work', clock: { deviceA: 3 } })

    const result = canvasFolderHandler.applyDelete(ctx(), 'cvf_work', { deviceB: 1 })

    expect(result).toBe('skipped')
    expect(row('cvf_work')?.deletedAt).toBeNull()
  })

  describe('the directory a remote delete leaves behind', () => {
    it('removes the emptied directory, mirroring how a canvas delete removes its file', () => {
      // Without this the directory outlives the tombstone, and the next
      // reconcile adopts it back as a live folder — the user deletes a folder on
      // one device and it reappears on the others.
      fs.mkdirSync(folderDir('Work'), { recursive: true })
      seedRow({ id: 'cvf_work', path: 'Work', clock: { deviceA: 1 } })

      expect(canvasFolderHandler.applyDelete(ctx(), 'cvf_work', { deviceA: 2 })).toBe('applied')

      expect(fs.existsSync(folderDir('Work'))).toBe(false)
    })

    it('removes an emptied child directory along with its parent', () => {
      // The peer enqueues the folder delete before the canvas deletes, and a
      // parent cannot go until its children have — so the prune walks bottom-up
      // rather than giving up on the first non-empty read.
      fs.mkdirSync(folderDir('Work', 'Q3'), { recursive: true })
      seedRow({ id: 'cvf_work', path: 'Work', clock: { deviceA: 1 } })

      canvasFolderHandler.applyDelete(ctx(), 'cvf_work', { deviceA: 2 })

      expect(fs.existsSync(folderDir('Work'))).toBe(false)
    })

    it('leaves a document a peer failed to remove exactly where it is', () => {
      // Removing a canvas file can fail (a locked file, a refused trash). The
      // tombstone still stands, but the ink is the user's and this handler never
      // deletes a file.
      fs.mkdirSync(folderDir('Work'), { recursive: true })
      fs.writeFileSync(folderDir('Work', 'Plan.excalidraw'), '{}')
      seedRow({ id: 'cvf_work', path: 'Work', clock: { deviceA: 1 } })

      expect(canvasFolderHandler.applyDelete(ctx(), 'cvf_work', { deviceA: 2 })).toBe('applied')

      expect(fs.existsSync(folderDir('Work', 'Plan.excalidraw'))).toBe(true)
      expect(fs.existsSync(folderDir('Work'))).toBe(true)
    })

    it('leaves the directory alone when the delete is skipped', () => {
      fs.mkdirSync(folderDir('Work'), { recursive: true })
      seedRow({ id: 'cvf_work', path: 'Work', clock: { deviceA: 3 } })

      expect(canvasFolderHandler.applyDelete(ctx(), 'cvf_work', { deviceB: 1 })).toBe('skipped')

      expect(fs.existsSync(folderDir('Work'))).toBe(true)
    })

    it('applies the tombstone even with no vault open', () => {
      vaultDir.current = ''
      seedRow({ id: 'cvf_work', path: 'Work', clock: { deviceA: 1 } })

      expect(canvasFolderHandler.applyDelete(ctx(), 'cvf_work', { deviceA: 2 })).toBe('applied')
      expect(row('cvf_work')?.deletedAt).toBeTruthy()
    })

    /**
     * The ordering that leaves the directory behind is the DEFAULT one, not a
     * rare race: `canvas` and `canvas_folder` share a rank in `PULL_APPLY_ORDER`,
     * so a peer's folder delete regularly applies while the documents inside it
     * are still on disk. `rmdir` refuses an occupied directory — that refusal is
     * the safety property — and nothing in the apply path ever comes back to it.
     *
     * The retry lives in reconcile, at vault open: ordering-independent, and it
     * already walks the tree. This is the whole round trip through both real
     * handlers, because the bug only exists in the seam between them.
     */
    it('is swept up at the next vault open when the canvas deletes land after it', async () => {
      const folderId = canvasFolderSyncId('Work')
      const filePath = `${CANVAS_DIR}/Work/Plan.excalidraw`
      fs.mkdirSync(folderDir('Work'), { recursive: true })
      fs.writeFileSync(
        folderDir('Work', 'Plan.excalidraw'),
        withCanvasMeta('', { id: 'cv_plan', createdAt: 1, updatedAt: 1 })
      )
      db.insert(canvases)
        .values({
          id: 'cv_plan',
          vaultId: VAULT_ID,
          title: 'Plan',
          filePath,
          folder: 'Work',
          snapshotCiphertext: '',
          vectorClock: {},
          createdAt: 1,
          updatedAt: 1,
          deletedAt: null,
          lastSyncedAt: null,
          clock: { deviceA: 1 }
        })
        .run()
      seedRow({ id: folderId, path: 'Work', clock: { deviceA: 1 } })

      // 1. the folder delete applies first, with the document still inside
      expect(canvasFolderHandler.applyDelete(ctx(), folderId, { deviceA: 2 })).toBe('applied')
      expect(fs.existsSync(folderDir('Work'))).toBe(true)

      // 2. then the canvas delete, which takes the document but not its folder
      expect(canvasHandler.applyDelete(ctx(), 'cv_plan', { deviceA: 2 })).toBe('applied')
      expect(fs.existsSync(folderDir('Work', 'Plan.excalidraw'))).toBe(false)
      expect(fs.existsSync(folderDir('Work'))).toBe(true)

      // 3. vault open sweeps up what the ordering left in the user's vault
      const result = await reconcileCanvasFiles(db, vaultDir.current, VAULT_ID)

      expect(result.foldersPruned).toBe(1)
      expect(fs.existsSync(folderDir('Work'))).toBe(false)
      // The canvases root is never swept, whatever else goes.
      expect(fs.existsSync(folderDir())).toBe(true)
      // Still deleted: the sweep is about the directory, never the tombstone.
      expect(row(folderId)?.deletedAt).toBeTruthy()
    })
  })

  it('hides tombstoned rows from fetchLocal', () => {
    seedRow({ id: 'cvf_work', path: 'Work', clock: { deviceA: 1 }, deletedAt: 99 })

    expect(canvasFolderHandler.fetchLocal(db, 'cvf_work')).toBeUndefined()
  })

  it('seeds one queue item per unclocked live row and skips tombstones', () => {
    seedRow({ id: 'cvf_work', path: 'Work' })
    seedRow({ id: 'cvf_personal', path: 'Personal' })
    seedRow({ id: 'cvf_gone', path: 'Gone', deletedAt: 42 })
    seedRow({ id: 'cvf_synced', path: 'Synced', clock: { deviceA: 1 } })

    const enqueue = vi.fn()
    const queue = { enqueue } as unknown as SyncQueueManager

    const seeded = canvasFolderHandler.seedUnclocked(db, 'deviceA', queue)

    expect(seeded).toBe(2)
    expect(enqueue).toHaveBeenCalledTimes(2)
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'canvas_folder', itemId: 'cvf_work', operation: 'create' })
    )
    expect(row('cvf_work')?.clock).toEqual({ deviceA: 1 })
    expect(row('cvf_gone')?.clock).toBeNull()
  })

  it('builds a push payload carrying path and icon', () => {
    seedRow({ id: 'cvf_work', path: 'Work', icon: '🎨', clock: { deviceA: 1 } })

    const json = canvasFolderHandler.buildPushPayload(db, 'cvf_work', 'deviceA', 'update')

    expect(json).not.toBeNull()
    expect(JSON.parse(json!)).toMatchObject({ path: 'Work', icon: '🎨', vaultId: VAULT_ID })
  })
})
