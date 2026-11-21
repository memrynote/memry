import { beforeEach, describe, expect, it, vi } from 'vitest'

import { canvasFolderService, onCanvasFolderUpdated } from './canvas-folder-service'

const commands = vi.hoisted(() => ({
  canvasFolderList: vi.fn(),
  canvasFolderCreate: vi.fn(),
  canvasFolderRename: vi.fn(),
  canvasFolderMove: vi.fn(),
  canvasFolderSetIcon: vi.fn(),
  canvasFolderDelete: vi.fn()
}))
const listen = vi.hoisted(() => ({ created: vi.fn(), updated: vi.fn(), deleted: vi.fn() }))

vi.mock('../../../generated/bindings', () => ({
  commands,
  events: {
    canvasFolderCreatedEvent: { listen: listen.created },
    canvasFolderUpdatedEvent: { listen: listen.updated },
    canvasFolderDeletedEvent: { listen: listen.deleted }
  }
}))

const folder = { id: 'f1', path: 'work/plans', icon: null, createdAt: 1, updatedAt: 2 }

beforeEach(() => {
  for (const command of Object.values(commands)) command.mockReset()
  for (const event of Object.values(listen)) event.mockReset().mockResolvedValue(() => undefined)
})

describe('canvas-folder-service', () => {
  it('creates at the root when no parent is given, and under a parent when one is', async () => {
    commands.canvasFolderCreate.mockResolvedValue({ folder })

    await expect(canvasFolderService.create({ name: 'work' })).resolves.toEqual({ folder })
    await canvasFolderService.create({ parent: 'work', name: 'plans' })

    expect(commands.canvasFolderCreate).toHaveBeenNthCalledWith(1, null, 'work')
    expect(commands.canvasFolderCreate).toHaveBeenNthCalledWith(2, 'work', 'plans')
  })

  it('renames, moves, sets the icon, deletes and lists through the commands', async () => {
    commands.canvasFolderRename.mockResolvedValue({ folder: null })
    commands.canvasFolderMove.mockResolvedValue({ folder })
    commands.canvasFolderSetIcon.mockResolvedValue({ folder })
    commands.canvasFolderDelete.mockResolvedValue({ success: true, deletedCanvasIds: ['c1'] })
    commands.canvasFolderList.mockResolvedValue({ folders: [folder] })

    await expect(canvasFolderService.rename({ path: 'work', name: 'job' })).resolves.toEqual({
      folder: null
    })
    await canvasFolderService.move({ path: 'work/plans', parent: null })
    await canvasFolderService.setIcon({ path: 'work/plans', icon: null })
    await expect(canvasFolderService.delete({ path: 'work' })).resolves.toEqual({
      success: true,
      deletedCanvasIds: ['c1']
    })
    await expect(canvasFolderService.list()).resolves.toEqual({ folders: [folder] })

    expect(commands.canvasFolderRename).toHaveBeenCalledWith('work', 'job')
    expect(commands.canvasFolderMove).toHaveBeenCalledWith('work/plans', null)
    expect(commands.canvasFolderSetIcon).toHaveBeenCalledWith('work/plans', null)
    expect(commands.canvasFolderDelete).toHaveBeenCalledWith('work')
  })

  it('rejects a refused move with the errors: key the tree translates', async () => {
    const refusal = {
      kind: 'invalid',
      code: 'CANVAS_FOLDER_DESCENDANT',
      message: 'errors:canvasFolder.descendant'
    }
    commands.canvasFolderMove.mockRejectedValue(refusal)

    await expect(canvasFolderService.move({ path: 'work', parent: 'work/plans' })).rejects.toBe(
      refusal
    )
  })

  it('reports a rename with its previous path and a plain update without one', () => {
    const callback = vi.fn()
    onCanvasFolderUpdated(callback)
    const deliver = listen.updated.mock.calls[0][0]

    deliver({ payload: { folder, previousPath: 'work/old' } })
    deliver({ payload: { folder, previousPath: null } })

    expect(callback).toHaveBeenNthCalledWith(1, { folder, previousPath: 'work/old' })
    expect(callback).toHaveBeenNthCalledWith(2, { folder })
  })
})
