import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

vi.mock('@excalidraw/excalidraw', () => ({
  convertToExcalidrawElements: vi.fn(),
  exportToSvg: vi.fn(),
  // jsdom's Blob has no arrayBuffer().
  exportToBlob: vi.fn(async () =>
    Object.assign(new Blob([PNG], { type: 'image/png' }), { arrayBuffer: async () => PNG.buffer })
  )
}))

const invokeBinary = vi.hoisted(() => vi.fn(async () => null))
vi.mock('@/lib/ipc-binary', () => ({ invokeBinary }))

import { copySceneAsImage, type MindMapSceneSource } from './mind-map-export'

const source = { getSceneElements: () => [], getFiles: () => ({}) } as unknown as MindMapSceneSource

describe('copySceneAsImage', () => {
  const write = vi.fn<(items: ClipboardItem[]) => Promise<void>>()

  beforeEach(() => {
    vi.stubGlobal(
      'ClipboardItem',
      class {
        constructor(readonly items: Record<string, Blob>) {}
      }
    )
    Object.defineProperty(navigator, 'clipboard', { value: { write }, configurable: true })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    write.mockReset()
    invokeBinary.mockClear()
  })

  it('writes the PNG through the webview when it accepts the image', async () => {
    write.mockResolvedValue(undefined)
    await copySceneAsImage(source)
    expect(write).toHaveBeenCalledTimes(1)
    expect(invokeBinary).not.toHaveBeenCalled()
  })

  it('puts the same PNG on the clipboard through the app when the webview refuses it', async () => {
    write.mockRejectedValue(new DOMException('no user gesture', 'NotAllowedError'))
    await copySceneAsImage(source)
    expect(invokeBinary).toHaveBeenCalledWith('clipboard_write_image', PNG, {})
  })

  it('surfaces a refused native write to the caller', async () => {
    write.mockRejectedValue(new DOMException('no user gesture', 'NotAllowedError'))
    invokeBinary.mockRejectedValueOnce({ code: 'clipboard_write', message: 'no clipboard' })
    await expect(copySceneAsImage(source)).rejects.toEqual({
      code: 'clipboard_write',
      message: 'no clipboard'
    })
  })
})
