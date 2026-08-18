import { describe, it, expect, vi, afterEach } from 'vitest'
import { CanvasFolderChannels } from '@memry/contracts/canvas-folder-api'
import { CanvasChannels } from '@memry/contracts/canvas-api'
import { enErrors } from '@memry/i18n/locales/en-errors'
import {
  CANVAS_FOLDER_ERROR_KEYS,
  registerCanvasFolderHandlers,
  unregisterCanvasFolderHandlers
} from './canvas-folder-handlers'
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
import { buildAssetServiceContext } from '../canvas/assets/asset-service-context'
import { reconcileCanvasAssets } from '../canvas/assets/asset-service'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn()
  },
  shell: {
    trashItem: vi.fn(async () => {})
  }
}))

// Registration must never touch the DB or keychain eagerly.
vi.mock('../database', () => ({
  requireDatabase: vi.fn(() => {
    throw new Error('No vault is open')
  })
}))
vi.mock('../crypto', () => ({
  getOrInitializeLocalVaultKey: vi.fn(() => {
    throw new Error('keychain must not be touched at registration')
  }),
  secureCleanup: vi.fn()
}))
vi.mock('../agent/storage/vault-id', () => ({
  getOrCreateVaultUuid: vi.fn(() => {
    throw new Error('db must not be touched at registration')
  })
}))
vi.mock('../canvas/vault-path', () => ({
  getCanvasVaultPath: vi.fn(() => '/vaults/Memry')
}))
vi.mock('../canvas/folder-store', () => ({
  createCanvasFolder: vi.fn(),
  deleteCanvasFolder: vi.fn(async () => []),
  listCanvasFolders: vi.fn(() => []),
  moveCanvasFolder: vi.fn(),
  renameCanvasFolder: vi.fn(),
  setCanvasFolderIcon: vi.fn()
}))
vi.mock('../lib/window-broadcast', () => ({
  broadcastToAllWindows: vi.fn()
}))
// Same reason canvas-handlers.test.ts stubs these: the real context builder
// pulls the whole attachment + writeback graph into a registration test, and the
// asset service is unit-tested in asset-service.test.ts. Here we only care that
// the handler calls it for every canvas the delete tombstoned.
vi.mock('../canvas/assets/asset-service-context', () => ({
  buildAssetServiceContext: vi.fn(() => null)
}))
vi.mock('../canvas/assets/asset-service', () => ({
  reconcileCanvasAssets: vi.fn(async () => {})
}))

const INVOKE_CHANNELS = Object.values(CanvasFolderChannels.invoke)

/**
 * Every invoke channel that CHANGES something, derived rather than listed: a
 * sixth mutating handler added later joins this set on its own, and the
 * translation test below then covers it whether or not anyone remembered to.
 */
const MUTATING_CHANNELS = Object.entries(CanvasFolderChannels.invoke)
  .filter(([name]) => name !== 'LIST')
  .map(([, channel]) => channel)

/** A valid input per mutating channel, so the handler reaches its store call. */
const MUTATION_INPUTS: Record<string, unknown> = {
  [CanvasFolderChannels.invoke.CREATE]: { parent: 'Work', name: 'Q3' },
  [CanvasFolderChannels.invoke.RENAME]: { path: 'Work/Q3', name: 'Q4' },
  [CanvasFolderChannels.invoke.MOVE]: { path: 'Work/Q3', parent: null },
  [CanvasFolderChannels.invoke.SET_ICON]: { path: 'Work', icon: '🎨' },
  [CanvasFolderChannels.invoke.DELETE]: { path: 'Work' }
}

function folder(path: string, icon: string | null = null) {
  return { id: `cvf_${path.toLowerCase()}`, path, icon, createdAt: 1, updatedAt: 2 }
}

type Handler = (event: unknown, input?: unknown) => Promise<unknown>

/** Register the handlers and return a channel -> handler lookup. */
async function registerAndGetHandlers(): Promise<Record<string, Handler>> {
  const { ipcMain } = await import('electron')
  const handleMock = vi.mocked(ipcMain.handle)
  handleMock.mockClear()
  registerCanvasFolderHandlers()
  const map: Record<string, Handler> = {}
  for (const [channel, handler] of handleMock.mock.calls) {
    map[channel as string] = handler as Handler
  }
  return map
}

/** Set up requireDatabase/getOrCreateVaultUuid so the canvas context resolves. */
async function withWorkingCanvasContext(): Promise<{ db: object }> {
  const { requireDatabase } = await import('../database')
  const { getOrCreateVaultUuid } = await import('../agent/storage/vault-id')
  const db = { marker: 'db' }
  vi.mocked(requireDatabase).mockReturnValue(db as never)
  vi.mocked(getOrCreateVaultUuid).mockReturnValue('vault-1')
  return { db }
}

describe('canvas folder handlers registration', () => {
  afterEach(() => {
    unregisterCanvasFolderHandlers()
    vi.clearAllMocks()
  })

  it('registers every canvas folder invoke channel without touching the DB', async () => {
    const { ipcMain } = await import('electron')
    const handleMock = vi.mocked(ipcMain.handle)
    handleMock.mockClear()

    expect(() => registerCanvasFolderHandlers()).not.toThrow()

    const registered = handleMock.mock.calls.map(([channel]) => channel)
    expect(registered.sort()).toEqual([...INVOKE_CHANNELS].sort())
  })

  it('unregisters every canvas folder invoke channel', async () => {
    const { ipcMain } = await import('electron')
    const removeMock = vi.mocked(ipcMain.removeHandler)
    removeMock.mockClear()

    unregisterCanvasFolderHandlers()

    const removed = removeMock.mock.calls.map(([channel]) => channel)
    expect(removed.sort()).toEqual([...INVOKE_CHANNELS].sort())
  })
})

describe('canvasFolder:list', () => {
  afterEach(() => {
    unregisterCanvasFolderHandlers()
    vi.clearAllMocks()
  })

  it('returns the vault’s folders from the store', async () => {
    const { db } = await withWorkingCanvasContext()
    const rows = [folder('Work'), folder('Work/Q3')]
    vi.mocked(listCanvasFolders).mockReturnValue(rows)
    const handlers = await registerAndGetHandlers()

    const result = await handlers[CanvasFolderChannels.invoke.LIST]({})

    expect(listCanvasFolders).toHaveBeenCalledWith(db, 'vault-1')
    expect(result).toEqual({ folders: rows })
  })
})

describe('canvasFolder:create', () => {
  afterEach(() => {
    unregisterCanvasFolderHandlers()
    vi.clearAllMocks()
  })

  it('creates under the given parent and announces the folder', async () => {
    const { db } = await withWorkingCanvasContext()
    const created = folder('Work/Q3')
    vi.mocked(createCanvasFolder).mockReturnValue(created)
    const handlers = await registerAndGetHandlers()

    const result = await handlers[CanvasFolderChannels.invoke.CREATE](
      {},
      { parent: 'Work', name: 'Q3' }
    )

    expect(createCanvasFolder).toHaveBeenCalledWith(db, '/vaults/Memry', 'vault-1', 'Work', 'Q3')
    expect(broadcastToAllWindows).toHaveBeenCalledWith(CanvasFolderChannels.events.CREATED, {
      folder: created
    })
    expect(result).toEqual({ folder: created })
  })

  it('treats an absent parent as the canvases root', async () => {
    await withWorkingCanvasContext()
    vi.mocked(createCanvasFolder).mockReturnValue(folder('Work'))
    const handlers = await registerAndGetHandlers()

    await handlers[CanvasFolderChannels.invoke.CREATE]({}, { name: 'Work' })

    expect(vi.mocked(createCanvasFolder).mock.calls[0][3]).toBeNull()
  })

  it('rejects a blank name without touching the store', async () => {
    await withWorkingCanvasContext()
    const handlers = await registerAndGetHandlers()

    await expect(handlers[CanvasFolderChannels.invoke.CREATE]({}, { name: '' })).rejects.toThrow(
      /Validation failed/
    )
    expect(createCanvasFolder).not.toHaveBeenCalled()
    expect(broadcastToAllWindows).not.toHaveBeenCalled()
  })
})

describe('canvasFolder:rename', () => {
  afterEach(() => {
    unregisterCanvasFolderHandlers()
    vi.clearAllMocks()
  })

  it('renames through the store and announces the previous path', async () => {
    const { db } = await withWorkingCanvasContext()
    const renamed = folder('Work/Q4')
    vi.mocked(renameCanvasFolder).mockReturnValue(renamed)
    const handlers = await registerAndGetHandlers()

    const result = await handlers[CanvasFolderChannels.invoke.RENAME](
      {},
      { path: 'Work/Q3', name: 'Q4' }
    )

    expect(renameCanvasFolder).toHaveBeenCalledWith(db, '/vaults/Memry', 'vault-1', 'Work/Q3', 'Q4')
    expect(broadcastToAllWindows).toHaveBeenCalledWith(CanvasFolderChannels.events.UPDATED, {
      folder: renamed,
      previousPath: 'Work/Q3'
    })
    expect(result).toEqual({ folder: renamed })
  })

  it('announces nothing when no live folder holds that path', async () => {
    await withWorkingCanvasContext()
    vi.mocked(renameCanvasFolder).mockReturnValue(null)
    const handlers = await registerAndGetHandlers()

    const result = await handlers[CanvasFolderChannels.invoke.RENAME](
      {},
      { path: 'Gone', name: 'Q4' }
    )

    expect(result).toEqual({ folder: null })
    expect(broadcastToAllWindows).not.toHaveBeenCalled()
  })

  it('rejects a blank name without touching the store', async () => {
    await withWorkingCanvasContext()
    const handlers = await registerAndGetHandlers()

    await expect(
      handlers[CanvasFolderChannels.invoke.RENAME]({}, { path: 'Work', name: '' })
    ).rejects.toThrow(/Validation failed/)
    expect(renameCanvasFolder).not.toHaveBeenCalled()
  })
})

describe('canvasFolder:move', () => {
  afterEach(() => {
    unregisterCanvasFolderHandlers()
    vi.clearAllMocks()
  })

  it('re-parents through the store and announces the previous path', async () => {
    const { db } = await withWorkingCanvasContext()
    const moved = folder('Archive/Q3')
    vi.mocked(moveCanvasFolder).mockReturnValue(moved)
    const handlers = await registerAndGetHandlers()

    const result = await handlers[CanvasFolderChannels.invoke.MOVE](
      {},
      { path: 'Work/Q3', parent: 'Archive' }
    )

    expect(moveCanvasFolder).toHaveBeenCalledWith(
      db,
      '/vaults/Memry',
      'vault-1',
      'Work/Q3',
      'Archive'
    )
    expect(broadcastToAllWindows).toHaveBeenCalledWith(CanvasFolderChannels.events.UPDATED, {
      folder: moved,
      previousPath: 'Work/Q3'
    })
    expect(result).toEqual({ folder: moved })
  })

  it('passes a null parent through as the canvases root', async () => {
    await withWorkingCanvasContext()
    vi.mocked(moveCanvasFolder).mockReturnValue(folder('Q3'))
    const handlers = await registerAndGetHandlers()

    await handlers[CanvasFolderChannels.invoke.MOVE]({}, { path: 'Work/Q3', parent: null })

    expect(vi.mocked(moveCanvasFolder).mock.calls[0][4]).toBeNull()
  })

  it('rejects an omitted parent — root must be an explicit null', async () => {
    await withWorkingCanvasContext()
    const handlers = await registerAndGetHandlers()

    await expect(
      handlers[CanvasFolderChannels.invoke.MOVE]({}, { path: 'Work/Q3' })
    ).rejects.toThrow(/Validation failed/)
    expect(moveCanvasFolder).not.toHaveBeenCalled()
  })
})

describe('canvasFolder:set-icon', () => {
  afterEach(() => {
    unregisterCanvasFolderHandlers()
    vi.clearAllMocks()
  })

  it('sets the icon through the store and announces the folder', async () => {
    const { db } = await withWorkingCanvasContext()
    const updated = folder('Work', '🎨')
    vi.mocked(setCanvasFolderIcon).mockReturnValue(updated)
    const handlers = await registerAndGetHandlers()

    const result = await handlers[CanvasFolderChannels.invoke.SET_ICON](
      {},
      { path: 'Work', icon: '🎨' }
    )

    // Icons are index-only, so the store takes no vault path here.
    expect(setCanvasFolderIcon).toHaveBeenCalledWith(db, 'vault-1', 'Work', '🎨')
    expect(broadcastToAllWindows).toHaveBeenCalledWith(CanvasFolderChannels.events.UPDATED, {
      folder: updated
    })
    expect(result).toEqual({ folder: updated })
  })

  it('clears the icon with an explicit null', async () => {
    await withWorkingCanvasContext()
    vi.mocked(setCanvasFolderIcon).mockReturnValue(folder('Work'))
    const handlers = await registerAndGetHandlers()

    await handlers[CanvasFolderChannels.invoke.SET_ICON]({}, { path: 'Work', icon: null })

    expect(vi.mocked(setCanvasFolderIcon).mock.calls[0][3]).toBeNull()
  })

  it('announces nothing when no live folder holds that path', async () => {
    await withWorkingCanvasContext()
    vi.mocked(setCanvasFolderIcon).mockReturnValue(null)
    const handlers = await registerAndGetHandlers()

    const result = await handlers[CanvasFolderChannels.invoke.SET_ICON](
      {},
      { path: 'Gone', icon: '🎨' }
    )

    expect(result).toEqual({ folder: null })
    expect(broadcastToAllWindows).not.toHaveBeenCalled()
  })
})

describe('canvasFolder:delete', () => {
  afterEach(() => {
    unregisterCanvasFolderHandlers()
    vi.clearAllMocks()
  })

  it('deletes through the store, trashes the directory and reports the canvases', async () => {
    const { db } = await withWorkingCanvasContext()
    const { shell } = await import('electron')
    vi.mocked(deleteCanvasFolder).mockResolvedValue(['canvas-1', 'canvas-2'])
    const handlers = await registerAndGetHandlers()

    const result = await handlers[CanvasFolderChannels.invoke.DELETE]({}, { path: 'Work' })

    const [dbArg, vaultPathArg, vaultIdArg, pathArg, trash] =
      vi.mocked(deleteCanvasFolder).mock.calls[0]
    expect(dbArg).toBe(db)
    expect(vaultPathArg).toBe('/vaults/Memry')
    expect(vaultIdArg).toBe('vault-1')
    expect(pathArg).toBe('Work')
    // The directory must reach the OS trash, not a hard delete.
    await trash('/vaults/Memry/canvases/Work')
    expect(shell.trashItem).toHaveBeenCalledWith('/vaults/Memry/canvases/Work')

    expect(broadcastToAllWindows).toHaveBeenCalledWith(CanvasFolderChannels.events.DELETED, {
      path: 'Work'
    })
    expect(result).toEqual({ success: true, deletedCanvasIds: ['canvas-1', 'canvas-2'] })
  })

  it('announces each canvas the folder took with it, before the folder itself', async () => {
    // The folder event carries a path, and a listener holding a canvas ID —
    // the tab closer — cannot match a path against it. Without these, a folder
    // delete reads as no canvas deletes at all.
    await withWorkingCanvasContext()
    vi.mocked(deleteCanvasFolder).mockResolvedValue(['canvas-1', 'canvas-2'])
    const handlers = await registerAndGetHandlers()

    await handlers[CanvasFolderChannels.invoke.DELETE]({}, { path: 'Work' })

    const broadcasts = vi.mocked(broadcastToAllWindows).mock.calls
    expect(broadcasts).toEqual([
      [CanvasChannels.events.DELETED, { id: 'canvas-1' }],
      [CanvasChannels.events.DELETED, { id: 'canvas-2' }],
      [CanvasFolderChannels.events.DELETED, { path: 'Work' }]
    ])
  })

  it('announces no canvas deletes when the folder held none', async () => {
    await withWorkingCanvasContext()
    vi.mocked(deleteCanvasFolder).mockResolvedValue([])
    const handlers = await registerAndGetHandlers()

    await handlers[CanvasFolderChannels.invoke.DELETE]({}, { path: 'Empty' })

    expect(vi.mocked(broadcastToAllWindows).mock.calls).toEqual([
      [CanvasFolderChannels.events.DELETED, { path: 'Empty' }]
    ])
  })

  it('rejects a blank path without touching the store', async () => {
    await withWorkingCanvasContext()
    const handlers = await registerAndGetHandlers()

    await expect(handlers[CanvasFolderChannels.invoke.DELETE]({}, { path: '' })).rejects.toThrow(
      /Validation failed/
    )
    expect(deleteCanvasFolder).not.toHaveBeenCalled()
    expect(broadcastToAllWindows).not.toHaveBeenCalled()
  })

  /**
   * A folder delete tombstones every canvas inside it, exactly as `canvas:delete`
   * does one at a time — so it owes the same asset GC. Without it the images
   * those canvases referenced keep their server ref_count forever: nothing else
   * ever revisits a tombstoned canvas's assets, so a leak here is permanent and
   * grows with every folder the user deletes.
   */
  describe('asset GC', () => {
    it('reconciles the assets of every canvas the delete tombstoned', async () => {
      await withWorkingCanvasContext()
      const fakeCtx = { marker: 'ctx' }
      vi.mocked(buildAssetServiceContext).mockReturnValue(fakeCtx as never)
      vi.mocked(deleteCanvasFolder).mockResolvedValue(['canvas-1', 'canvas-2'])
      const handlers = await registerAndGetHandlers()

      await handlers[CanvasFolderChannels.invoke.DELETE]({}, { path: 'Work' })

      // Empty scene = "this canvas references nothing now", the same argument
      // canvas:delete passes. The GC's other-canvas union protects anything a
      // surviving canvas still uses.
      expect(reconcileCanvasAssets).toHaveBeenCalledWith(fakeCtx, 'canvas-1', '')
      expect(reconcileCanvasAssets).toHaveBeenCalledWith(fakeCtx, 'canvas-2', '')
      expect(reconcileCanvasAssets).toHaveBeenCalledTimes(2)
    })

    it('skips reconcile when no vault is open (ctx is null)', async () => {
      await withWorkingCanvasContext()
      vi.mocked(buildAssetServiceContext).mockReturnValue(null)
      vi.mocked(deleteCanvasFolder).mockResolvedValue(['canvas-1'])
      const handlers = await registerAndGetHandlers()

      await handlers[CanvasFolderChannels.invoke.DELETE]({}, { path: 'Work' })

      expect(reconcileCanvasAssets).not.toHaveBeenCalled()
    })

    /**
     * Sequential, not `Promise.all`: two canvases in the same folder can share an
     * image, and the GC decides whether to dereference it on the server by asking
     * which OTHER canvases still hold a row for that hash. Run concurrently, both
     * calls read the union before either prunes, both see the other's row, and
     * neither dereferences — the shared asset leaks. One at a time, the second
     * call sees the first's rows gone and releases it.
     */
    it('reconciles one canvas at a time so a shared asset is still released', async () => {
      await withWorkingCanvasContext()
      vi.mocked(buildAssetServiceContext).mockReturnValue({ marker: 'ctx' } as never)
      vi.mocked(deleteCanvasFolder).mockResolvedValue(['canvas-1', 'canvas-2'])

      const inFlight: string[] = []
      const overlapped: string[] = []
      vi.mocked(reconcileCanvasAssets).mockImplementation(async (_ctx, canvasId) => {
        if (inFlight.length > 0) overlapped.push(canvasId)
        inFlight.push(canvasId)
        await Promise.resolve()
        inFlight.pop()
      })
      const handlers = await registerAndGetHandlers()

      await handlers[CanvasFolderChannels.invoke.DELETE]({}, { path: 'Work' })

      expect(overlapped).toEqual([])
    })
  })
})

describe('typed canvas folder failures', () => {
  afterEach(() => {
    unregisterCanvasFolderHandlers()
    vi.clearAllMocks()
  })

  it('gives every error code its own key in the English errors bundle', () => {
    const codes = Object.values(CanvasFolderErrorCode)
    const keys = codes.map((code) => CANVAS_FOLDER_ERROR_KEYS[code])

    // A shared key would put the renderer back where it started: one message
    // for a collision, a cycle and a depth breach alike.
    expect(new Set(keys).size).toBe(codes.length)
    for (const key of keys) {
      expect(key.startsWith('errors:canvasFolder.')).toBe(true)
      const leaf = key.slice('errors:canvasFolder.'.length)
      expect(
        (enErrors as Record<string, Record<string, string>>).canvasFolder?.[leaf],
        `missing English string for ${key}`
      ).toBeTruthy()
    }
  })

  it.each([
    [CanvasFolderErrorCode.EXISTS],
    [CanvasFolderErrorCode.DESCENDANT],
    [CanvasFolderErrorCode.MOVE_FAILED],
    [CanvasFolderErrorCode.DEPTH],
    [CanvasFolderErrorCode.INVALID_NAME]
  ])('sends %s to the renderer as its own i18n key', async (code) => {
    await withWorkingCanvasContext()
    vi.mocked(moveCanvasFolder).mockImplementation(() => {
      throw new CanvasFolderError('english prose the user must never see', code)
    })
    const handlers = await registerAndGetHandlers()

    await expect(
      handlers[CanvasFolderChannels.invoke.MOVE]({}, { path: 'Work/Q3', parent: 'Archive' })
    ).rejects.toThrow(CANVAS_FOLDER_ERROR_KEYS[code])
  })

  it('translates a create failure too — the depth cap fires there, not on move', async () => {
    await withWorkingCanvasContext()
    vi.mocked(createCanvasFolder).mockImplementation(() => {
      throw new CanvasFolderError('too deep', CanvasFolderErrorCode.DEPTH)
    })
    const handlers = await registerAndGetHandlers()

    await expect(
      handlers[CanvasFolderChannels.invoke.CREATE]({}, { parent: 'a/b/c/d/e/f/g/h', name: 'i' })
    ).rejects.toThrow(CANVAS_FOLDER_ERROR_KEYS[CanvasFolderErrorCode.DEPTH])
    expect(broadcastToAllWindows).not.toHaveBeenCalled()
  })

  it('translates a rename failure too', async () => {
    await withWorkingCanvasContext()
    vi.mocked(renameCanvasFolder).mockImplementation(() => {
      throw new CanvasFolderError('taken', CanvasFolderErrorCode.EXISTS)
    })
    const handlers = await registerAndGetHandlers()

    await expect(
      handlers[CanvasFolderChannels.invoke.RENAME]({}, { path: 'Work/Q3', name: 'Q4' })
    ).rejects.toThrow(CANVAS_FOLDER_ERROR_KEYS[CanvasFolderErrorCode.EXISTS])
  })

  it('has an input for every mutating channel — a new handler must be covered below', () => {
    // The guard on the guard: without it, a sixth mutating handler would simply
    // be absent from the sweep instead of failing it.
    expect(Object.keys(MUTATION_INPUTS).sort()).toEqual([...MUTATING_CHANNELS].sort())
  })

  it.each(MUTATING_CHANNELS)(
    '%s translates its store failure instead of leaking English prose',
    async (channel) => {
      await withWorkingCanvasContext()
      const boom = (): never => {
        throw new CanvasFolderError(
          'english prose the user must never see',
          CanvasFolderErrorCode.EXISTS
        )
      }
      // Every store entry point throws, so the sweep does not need to know which
      // one a given handler calls — including one added after this was written.
      vi.mocked(createCanvasFolder).mockImplementation(boom)
      vi.mocked(renameCanvasFolder).mockImplementation(boom)
      vi.mocked(moveCanvasFolder).mockImplementation(boom)
      vi.mocked(setCanvasFolderIcon).mockImplementation(boom)
      vi.mocked(deleteCanvasFolder).mockImplementation(boom)
      const handlers = await registerAndGetHandlers()

      await expect(handlers[channel]({}, MUTATION_INPUTS[channel])).rejects.toThrow(
        CANVAS_FOLDER_ERROR_KEYS[CanvasFolderErrorCode.EXISTS]
      )
      // A failed mutation describes nothing, so no window hears about one.
      expect(broadcastToAllWindows).not.toHaveBeenCalled()
    }
  )

  it('leaves an untyped failure alone rather than mislabelling it', async () => {
    await withWorkingCanvasContext()
    vi.mocked(moveCanvasFolder).mockImplementation(() => {
      throw new Error('the index is on fire')
    })
    const handlers = await registerAndGetHandlers()

    await expect(
      handlers[CanvasFolderChannels.invoke.MOVE]({}, { path: 'Work/Q3', parent: null })
    ).rejects.toThrow('the index is on fire')
  })
})
