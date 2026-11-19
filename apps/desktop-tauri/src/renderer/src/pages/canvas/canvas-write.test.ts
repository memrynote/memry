import { beforeEach, describe, expect, it, vi } from 'vitest'

import { writeCanvas } from './canvas-write'

const commands = vi.hoisted(() => ({ canvasGet: vi.fn(), canvasUpdate: vi.fn() }))

vi.mock('../../../../generated/bindings', () => ({ commands, events: {} }))

const ref = { entityType: 'note' as const, entityId: 'n1' }

beforeEach(() => {
  commands.canvasGet.mockReset()
  commands.canvasUpdate.mockReset()
})

describe('writeCanvas with no live editor', () => {
  it('saves the scene it read, guarded by the updatedAt of that read', async () => {
    commands.canvasGet.mockResolvedValue({
      id: 'c1',
      title: 'Board',
      folder: null,
      icon: null,
      ownerNoteId: null,
      createdAt: 1,
      updatedAt: 7,
      scene: JSON.stringify({ type: 'excalidraw', elements: [] })
    })
    commands.canvasUpdate.mockResolvedValue({ updatedAt: 9, tooLarge: true })

    const result = await writeCanvas('c1', () => ({ elements: [], applied: [ref], skipped: [] }))

    expect(commands.canvasGet).toHaveBeenCalledWith('c1')
    expect(commands.canvasUpdate).toHaveBeenCalledWith({
      id: 'c1',
      scene: JSON.stringify({ type: 'excalidraw', elements: [] }),
      expectedUpdatedAt: 7
    })
    expect(result).toMatchObject({ updatedAt: 9, tooLarge: true, path: 'headless' })
  })

  it('refuses a canvas that is gone instead of writing a new one', async () => {
    commands.canvasGet.mockResolvedValue(null)

    await expect(
      writeCanvas('gone', () => ({ elements: [], applied: [], skipped: [] }))
    ).rejects.toThrow('Canvas gone not found')
    expect(commands.canvasUpdate).not.toHaveBeenCalled()
  })
})
