import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppChannels } from '@memry/contracts/ipc-channels'

const { ipcHandlers, fromWebContents } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (event: unknown, ...args: unknown[]) => void>(),
  fromWebContents: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents },
  ipcMain: {
    on: (channel: string, handler: (event: unknown, ...args: unknown[]) => void) =>
      ipcHandlers.set(channel, handler)
  },
  nativeTheme: { shouldUseDarkColors: false }
}))

import { getMainWindowFrameOptions, registerTitleBarOverlayIpc } from './title-bar-overlay'

describe('getMainWindowFrameOptions', () => {
  it('keeps macOS on the hidden title bar with native traffic lights', () => {
    expect(getMainWindowFrameOptions('darwin')).toEqual({
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 12, y: 12 }
    })
  })

  it('draws Windows caption buttons over the 36px title row, glyphs following the theme', () => {
    expect(getMainWindowFrameOptions('win32', () => true)).toMatchObject({
      titleBarStyle: 'hidden',
      titleBarOverlay: { height: 36, symbolColor: '#e5e5e5' }
    })
    expect(getMainWindowFrameOptions('win32', () => false)).toMatchObject({
      titleBarOverlay: { symbolColor: '#3f3f3f' }
    })
  })

  it('leaves Linux on the native frame', () => {
    expect(getMainWindowFrameOptions('linux')).toEqual({})
  })
})

describe('registerTitleBarOverlayIpc', () => {
  const setTitleBarOverlay = vi.fn()

  beforeEach(() => {
    ipcHandlers.clear()
    setTitleBarOverlay.mockReset()
    fromWebContents.mockReturnValue({ isDestroyed: () => false, setTitleBarOverlay })
  })

  function registerOn(platform: NodeJS.Platform): void {
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: platform })
    try {
      registerTitleBarOverlayIpc()
    } finally {
      Object.defineProperty(process, 'platform', { value: original })
    }
  }

  it('applies a hex symbol color to the sending window and ignores anything else', () => {
    registerOn('win32')
    const handler = ipcHandlers.get(AppChannels.send.TITLE_BAR_SYMBOL_COLOR)
    if (!handler) throw new Error('handler not registered')

    handler({ sender: {} }, '#1a1a1a')
    expect(setTitleBarOverlay).toHaveBeenCalledWith(
      expect.objectContaining({ symbolColor: '#1a1a1a' })
    )

    setTitleBarOverlay.mockClear()
    handler({ sender: {} }, 'oklch(0.2 0 0)')
    handler({ sender: {} }, 42)
    expect(setTitleBarOverlay).not.toHaveBeenCalled()
  })

  it('does not listen outside Windows', () => {
    registerOn('darwin')
    expect(ipcHandlers.size).toBe(0)
  })
})
