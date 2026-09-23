import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeWindow {
  visible: boolean
  minimized: boolean
  focused: boolean
  isMinimized: () => boolean
  restore: () => void
  isVisible: () => boolean
  show: () => void
  focus: () => void
}

const desktop = {
  windows: [] as FakeWindow[],
  appActive: false,
  answer: 0,
  shown: [] as { parentVisible: boolean; appActive: boolean; detail: string; buttons: string[] }[]
}

function fakeWindow(state: { visible: boolean; minimized: boolean }): FakeWindow {
  const win: FakeWindow = {
    ...state,
    focused: false,
    isMinimized: () => win.minimized,
    restore: () => {
      win.minimized = false
    },
    isVisible: () => win.visible,
    show: () => {
      win.visible = true
    },
    focus: () => {
      win.focused = true
    }
  }
  return win
}

vi.mock('electron', () => ({
  app: {
    focus: (options?: { steal: boolean }) => {
      if (options?.steal) desktop.appActive = true
    }
  },
  BrowserWindow: { getAllWindows: () => desktop.windows },
  dialog: {
    showMessageBox: async (parent: FakeWindow, options: { detail: string; buttons: string[] }) => {
      desktop.shown.push({
        parentVisible: parent.visible && !parent.minimized,
        appActive: desktop.appActive,
        detail: options.detail,
        buttons: options.buttons
      })
      return { response: desktop.answer }
    }
  }
}))

const { showPairConsentDialog } = await import('./consent-dialog')

describe('showPairConsentDialog', () => {
  const platform = process.platform

  beforeEach(() => {
    desktop.windows = []
    desktop.appActive = false
    desktop.answer = 0
    desktop.shown = []
    Object.defineProperty(process, 'platform', { value: 'darwin' })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform })
  })

  it('brings a hidden window and the app forward before asking, so the sheet is visible', async () => {
    desktop.windows = [fakeWindow({ visible: false, minimized: false })]

    const allowed = await showPairConsentDialog('chrome-extension://abc')

    expect(allowed).toBe(true)
    expect(desktop.shown).toEqual([
      {
        parentVisible: true,
        appActive: true,
        detail: 'chrome-extension://abc',
        buttons: ['Allow', 'Deny']
      }
    ])
  })

  it('restores a minimized window and reports Deny as not allowed', async () => {
    desktop.windows = [fakeWindow({ visible: true, minimized: true })]
    desktop.answer = 1

    const allowed = await showPairConsentDialog('moz-extension://xyz')

    expect(allowed).toBe(false)
    expect(desktop.shown[0].parentVisible).toBe(true)
  })

  it('declines when there is no window to attach the dialog to', async () => {
    expect(await showPairConsentDialog('chrome-extension://abc')).toBe(false)
    expect(desktop.shown).toHaveLength(0)
  })
})
