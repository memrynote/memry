import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { canvasService, onCanvasCreated, onCanvasTooLarge } from './canvas-service'

const commands = vi.hoisted(() => ({
  canvasCreate: vi.fn(),
  canvasGet: vi.fn(),
  canvasUpdate: vi.fn(),
  canvasDelete: vi.fn(),
  canvasList: vi.fn(),
  canvasDuplicate: vi.fn(),
  canvasRevealInFinder: vi.fn(),
  canvasOpenExternal: vi.fn(),
  canvasLibraryList: vi.fn(),
  canvasLibrarySave: vi.fn()
}))
const listen = vi.hoisted(() => ({
  created: vi.fn(),
  updated: vi.fn(),
  deleted: vi.fn(),
  tooLarge: vi.fn()
}))

vi.mock('../../../generated/bindings', () => ({
  commands,
  events: {
    canvasCreatedEvent: { listen: listen.created },
    canvasUpdatedEvent: { listen: listen.updated },
    canvasDeletedEvent: { listen: listen.deleted },
    canvasTooLargeEvent: { listen: listen.tooLarge }
  }
}))

type WindowWithApi = typeof window & { api: Record<string, unknown> }

const win = window as WindowWithApi
const originalApi = win.api

const summary = {
  id: 'c1',
  title: 'Board',
  folder: null,
  icon: null,
  ownerNoteId: null,
  createdAt: 1,
  updatedAt: 2
}

beforeEach(() => {
  for (const command of Object.values(commands)) command.mockReset()
  for (const event of Object.values(listen)) event.mockReset().mockResolvedValue(() => undefined)
})

afterEach(() => {
  win.api = originalApi
})

describe('canvas-service', () => {
  it('creates through canvas_create, an absent input as an empty one', async () => {
    commands.canvasCreate.mockResolvedValue({
      ...summary,
      scene: '',
      sha256: 'sha-0',
      unreadable: null
    })

    await expect(canvasService.create()).resolves.toEqual({
      ...summary,
      scene: '',
      sha256: 'sha-0'
    })
    await canvasService.create({ folder: 'work', title: 'Plan' })

    expect(commands.canvasCreate).toHaveBeenNthCalledWith(1, {})
    expect(commands.canvasCreate).toHaveBeenNthCalledWith(2, { folder: 'work', title: 'Plan' })
  })

  it('reads a canvas, keeping the unreadable flag a link out of the vault carries', async () => {
    commands.canvasGet.mockResolvedValueOnce({
      ...summary,
      scene: '{}',
      sha256: null,
      unreadable: true
    })
    commands.canvasGet.mockResolvedValueOnce(null)

    await expect(canvasService.get('c1')).resolves.toEqual({
      ...summary,
      scene: '{}',
      sha256: null,
      unreadable: true
    })
    await expect(canvasService.get('gone')).resolves.toBeNull()
    expect(commands.canvasGet).toHaveBeenCalledWith('c1')
  })

  it('saves with the guard it read and without the advisory entity refs', async () => {
    commands.canvasUpdate.mockResolvedValue({ ...summary, tooLarge: false })

    await canvasService.update({
      id: 'c1',
      scene: '{"elements":[]}',
      entityRefs: [{ entityType: 'note', entityId: 'n1' }],
      expectedUpdatedAt: 2,
      expectedSha256: 'sha-2'
    })

    expect(commands.canvasUpdate).toHaveBeenCalledWith({
      id: 'c1',
      scene: '{"elements":[]}',
      expectedUpdatedAt: 2,
      expectedSha256: 'sha-2'
    })
  })

  it('rejects a conflicting save with the message of the command', async () => {
    const refusal = { kind: 'conflict', code: 'canvas_conflict', message: 'canvas_conflict' }
    commands.canvasUpdate.mockRejectedValue(refusal)

    await expect(canvasService.update({ id: 'c1', expectedUpdatedAt: 1 })).rejects.toBe(refusal)
  })

  it('lists, deletes, duplicates, reveals, opens and keeps the library through commands', async () => {
    commands.canvasList.mockResolvedValue({ canvases: [summary] })
    commands.canvasDelete.mockResolvedValue({ success: true })
    commands.canvasDuplicate.mockResolvedValue(null)
    commands.canvasLibraryList.mockResolvedValue({ libraryItems: [{ id: 'l1' }] })
    commands.canvasLibrarySave.mockResolvedValue({ changed: 1 })

    await expect(canvasService.list()).resolves.toEqual({ canvases: [summary] })
    await expect(canvasService.delete('c1')).resolves.toEqual({ success: true })
    await expect(canvasService.duplicate('c1')).resolves.toBeNull()
    await canvasService.revealInFinder('c1')
    await canvasService.openExternal('c1')
    await expect(canvasService.libraryList()).resolves.toEqual({ libraryItems: [{ id: 'l1' }] })
    await expect(canvasService.librarySave([{ id: 'l1' }])).resolves.toEqual({ changed: 1 })

    expect(commands.canvasRevealInFinder).toHaveBeenCalledWith('c1')
    expect(commands.canvasOpenExternal).toHaveBeenCalledWith('c1')
    expect(commands.canvasLibrarySave).toHaveBeenCalledWith({ libraryItems: [{ id: 'l1' }] })
  })

  it('leaves the live and asset calls on window.api.canvas', async () => {
    const liveOpened = vi.fn().mockResolvedValue({ ok: true })
    win.api = { ...originalApi, canvas: { liveOpened } }

    await expect(canvasService.liveOpened('c1')).resolves.toEqual({ ok: true })
    expect(liveOpened).toHaveBeenCalledWith('c1')
  })

  it('delivers the canvas events of main and stops on unsubscribe', async () => {
    const created = vi.fn()
    const tooLarge = vi.fn()

    const stop = onCanvasCreated(created)
    onCanvasTooLarge(tooLarge)
    listen.created.mock.calls[0][0]({ payload: { canvas: summary } })
    listen.tooLarge.mock.calls[0][0]({ payload: { id: 'c1' } })
    stop()
    listen.created.mock.calls[0][0]({ payload: { canvas: summary } })

    expect(created).toHaveBeenCalledTimes(1)
    expect(created).toHaveBeenCalledWith({ canvas: summary })
    expect(tooLarge).toHaveBeenCalledWith({ id: 'c1' })
  })
})
