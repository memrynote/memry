/**
 * Canvas folder IPC handlers.
 *
 * A canvas folder is a real directory under `<vault>/canvases`; `folder-store`
 * owns disk and index together. These handlers are the thin part: validate,
 * call the store, announce the result to every window.
 *
 * A mutation that resolves to `null` (no live folder holds that path — another
 * device or Finder already changed the tree) emits nothing: there is no folder
 * to describe, and a fabricated event would put a ghost row in every sidebar.
 *
 * @module ipc/canvas-folder-handlers
 */

import { ipcMain, shell } from 'electron'
import {
  CanvasFolderChannels,
  CanvasFolderCreateSchema,
  CanvasFolderDeleteSchema,
  CanvasFolderMoveSchema,
  CanvasFolderRenameSchema,
  CanvasFolderSetIconSchema,
  type CanvasFolderDeleteResponse,
  type CanvasFolderListResponse,
  type CanvasFolderMutationResponse
} from '@memry/contracts/canvas-folder-api'
import { CanvasChannels } from '@memry/contracts/canvas-api'
import { createHandler, createValidatedHandler } from './validate'
import { getCanvasContext } from '../canvas/vault-key'
import { reconcileCanvasAssets } from '../canvas/assets/asset-service'
import { buildAssetServiceContext } from '../canvas/assets/asset-service-context'
import { CanvasFolderError, CanvasFolderErrorCode } from '../canvas/folder-errors'
import {
  createCanvasFolder,
  deleteCanvasFolder,
  listCanvasFolders,
  moveCanvasFolder,
  renameCanvasFolder,
  setCanvasFolderIcon
} from '../canvas/folder-store'
import { broadcastToAllWindows } from '../lib/window-broadcast'

/**
 * One i18n key per failure the user can cause. Distinct on purpose: a collision,
 * a cycle, a depth breach and a blank name are four different things to fix, and
 * a shared string tells the user none of them.
 */
export const CANVAS_FOLDER_ERROR_KEYS: Record<CanvasFolderErrorCode, string> = {
  [CanvasFolderErrorCode.EXISTS]: 'errors:canvasFolder.exists',
  [CanvasFolderErrorCode.DESCENDANT]: 'errors:canvasFolder.descendant',
  [CanvasFolderErrorCode.MOVE_FAILED]: 'errors:canvasFolder.moveFailed',
  [CanvasFolderErrorCode.DEPTH]: 'errors:canvasFolder.depth',
  [CanvasFolderErrorCode.INVALID_NAME]: 'errors:canvasFolder.invalidName'
}

/**
 * Carries a store failure's typed code to the renderer.
 *
 * The MESSAGE is the only field that survives: `createValidatedHandler` rebuilds
 * a thrown error as a plain `new Error(error.message)`, and Electron's `invoke`
 * rejection only ever carries a string anyway — a `code` property attached here
 * would never arrive. So the code becomes an `errors:` i18n key, which is the
 * envelope convention the renderer's `extractErrorMessage` already translates.
 *
 * Anything untyped is rethrown untouched: labelling an unexpected failure as a
 * name collision would be worse than the English text.
 */
async function withTranslatedFolderError<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof CanvasFolderError) throw new Error(CANVAS_FOLDER_ERROR_KEYS[err.code])
    throw err
  }
}

export function registerCanvasFolderHandlers(): void {
  // canvasFolder:list - Every live folder in the current vault
  ipcMain.handle(
    CanvasFolderChannels.invoke.LIST,
    createHandler(async (): Promise<CanvasFolderListResponse> => {
      const { db, vaultId } = getCanvasContext()
      return { folders: listCanvasFolders(db, vaultId) }
    })
  )

  // canvasFolder:create - Make a directory (and its row) under `parent`
  ipcMain.handle(
    CanvasFolderChannels.invoke.CREATE,
    createValidatedHandler(
      CanvasFolderCreateSchema,
      async (input): Promise<CanvasFolderMutationResponse> => {
        const { db, vaultId, vaultPath } = getCanvasContext()
        const folder = await withTranslatedFolderError(() =>
          createCanvasFolder(db, vaultPath, vaultId, input.parent ?? null, input.name)
        )
        broadcastToAllWindows(CanvasFolderChannels.events.CREATED, { folder })
        return { folder }
      }
    )
  )

  // canvasFolder:rename - Rename in place, keeping the parent
  ipcMain.handle(
    CanvasFolderChannels.invoke.RENAME,
    createValidatedHandler(
      CanvasFolderRenameSchema,
      async (input): Promise<CanvasFolderMutationResponse> => {
        const { db, vaultId, vaultPath } = getCanvasContext()
        const folder = await withTranslatedFolderError(() =>
          renameCanvasFolder(db, vaultPath, vaultId, input.path, input.name)
        )
        if (!folder) return { folder: null }
        // previousPath is what lets a listener re-key state filed under the old
        // path (expansion, selection) instead of stranding it.
        broadcastToAllWindows(CanvasFolderChannels.events.UPDATED, {
          folder,
          previousPath: input.path
        })
        return { folder }
      }
    )
  )

  // canvasFolder:move - Re-parent, keeping the folder's own name
  ipcMain.handle(
    CanvasFolderChannels.invoke.MOVE,
    createValidatedHandler(
      CanvasFolderMoveSchema,
      async (input): Promise<CanvasFolderMutationResponse> => {
        const { db, vaultId, vaultPath } = getCanvasContext()
        const folder = await withTranslatedFolderError(() =>
          moveCanvasFolder(db, vaultPath, vaultId, input.path, input.parent)
        )
        if (!folder) return { folder: null }
        broadcastToAllWindows(CanvasFolderChannels.events.UPDATED, {
          folder,
          previousPath: input.path
        })
        return { folder }
      }
    )
  )

  // canvasFolder:set-icon - Index-only; the directory is untouched
  ipcMain.handle(
    CanvasFolderChannels.invoke.SET_ICON,
    createValidatedHandler(
      CanvasFolderSetIconSchema,
      async (input): Promise<CanvasFolderMutationResponse> => {
        const { db, vaultId } = getCanvasContext()
        const folder = await withTranslatedFolderError(() =>
          setCanvasFolderIcon(db, vaultId, input.path, input.icon)
        )
        if (!folder) return { folder: null }
        broadcastToAllWindows(CanvasFolderChannels.events.UPDATED, { folder })
        return { folder }
      }
    )
  )

  // canvasFolder:delete - Tombstone the subtree, then trash the directory
  ipcMain.handle(
    CanvasFolderChannels.invoke.DELETE,
    createValidatedHandler(
      CanvasFolderDeleteSchema,
      async (input): Promise<CanvasFolderDeleteResponse> => {
        const { db, vaultId, vaultPath } = getCanvasContext()
        // The directory goes to the OS trash, not straight to /dev/null: a canvas
        // folder holds real files in the user's vault, and a mis-click must be
        // recoverable from Finder/Explorer.
        const deletedCanvasIds = await withTranslatedFolderError(() =>
          deleteCanvasFolder(db, vaultPath, vaultId, input.path, (abs) => shell.trashItem(abs))
        )

        // The same asset GC `canvas:delete` runs, once per canvas the folder
        // took with it. Without it the images those canvases referenced keep
        // their server ref_count forever — nothing else ever revisits a
        // tombstoned canvas's assets, so the leak is permanent and grows with
        // every folder deleted. An empty scene says "this canvas references
        // nothing now"; the GC's other-canvas union protects whatever a
        // surviving canvas still uses.
        //
        // Sequentially, never `Promise.all`: two canvases in one folder can
        // share an image, and that union is read from the asset ROWS. Run
        // concurrently, each call would still see the other's row and neither
        // would dereference the shared hash. One at a time, the last holder
        // releases it.
        //
        // After the tombstones rather than before (the mirror image of
        // `canvas:delete`, which GCs first) because the store call is what
        // tombstones them and reports their ids. Safe: the union is row-based,
        // not liveness-based, so the tombstone does not change what it sees —
        // and `dereference` never throws, so a delete that already committed
        // cannot be reported to the user as a failure.
        const assetCtx = buildAssetServiceContext()
        if (assetCtx) {
          for (const id of deletedCanvasIds) {
            await reconcileCanvasAssets(assetCtx, id, '')
          }
        }

        // One `canvas:deleted` per canvas the folder took with it, alongside the
        // folder event. The folder event carries a path, and a path is not
        // something a listener holding a canvas ID can match — so without these,
        // every consumer keyed on canvas identity (tab closing today) sees a
        // folder delete as no deletes at all. `deletedCanvasIds` covers
        // descendants too, so a canvas nested three folders down is included.
        //
        // Emitted BEFORE the folder event: a listener that reacts to the folder
        // event by re-reading the tree should already have seen the canvases go.
        for (const id of deletedCanvasIds) {
          broadcastToAllWindows(CanvasChannels.events.DELETED, { id })
        }
        broadcastToAllWindows(CanvasFolderChannels.events.DELETED, { path: input.path })
        return { success: true, deletedCanvasIds }
      }
    )
  )
}

export function unregisterCanvasFolderHandlers(): void {
  for (const channel of Object.values(CanvasFolderChannels.invoke)) {
    ipcMain.removeHandler(channel)
  }
}
