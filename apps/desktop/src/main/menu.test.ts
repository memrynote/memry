import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserWindow } from 'electron'
import { AppChannels } from '@memry/contracts/ipc-channels'
import { createMainI18n } from '@memry/i18n/main'

const { buildFromTemplate } = vi.hoisted(() => ({
  buildFromTemplate: vi.fn((template: unknown) => ({ template }))
}))

vi.mock('electron', () => ({
  app: { name: 'MemryNote' },
  BrowserWindow: { getFocusedWindow: vi.fn(), getAllWindows: vi.fn(() => []) },
  Menu: { buildFromTemplate }
}))

import {
  buildAppMenu,
  buildEditableTextContextMenu,
  readRendererHistoryState,
  usesRendererHistory
} from './menu'

interface TemplateItem {
  label?: string
  role?: string
  accelerator?: string
  registerAccelerator?: boolean
  id?: string
  click?: () => void
  submenu?: TemplateItem[]
}

/** Find an item by label in the most recently built template. */
function findMenuItem(label: string): TemplateItem | undefined {
  const template = buildFromTemplate.mock.calls.at(-1)?.[0] as TemplateItem[]
  return template.flatMap((item) => item.submenu ?? []).find((item) => item.label === label)
}

describe('buildAppMenu', () => {
  beforeEach(() => {
    buildFromTemplate.mockClear()
    vi.mocked(BrowserWindow.getFocusedWindow).mockReset().mockReturnValue(null)
    vi.mocked(BrowserWindow.getAllWindows).mockReset().mockReturnValue([])
  })

  it('labels every current native menu item from menu.json', async () => {
    const i18n = await createMainI18n({ locale: 'en' })

    buildAppMenu(i18n)

    const template = buildFromTemplate.mock.calls[0][0] as Array<{
      label?: string
      submenu?: Array<{ label?: string; role?: string }>
    }>

    expect(template.map((item) => item.label)).toContain('File')
    expect(template.map((item) => item.label)).toContain('Edit')
    expect(template.map((item) => item.label)).toContain('View')
    // Regression: the About item must carry an explicit label — the role
    // default would render "About @memry/desktop" from app.name.
    expect(template.flatMap((item) => item.submenu ?? []).map((item) => item.label)).toContain(
      'About MemryNote'
    )
    expect(template.flatMap((item) => item.submenu ?? []).map((item) => item.label)).toEqual(
      expect.arrayContaining([
        'New Note',
        'Back',
        'Forward',
        'Close Window',
        'Undo',
        'Redo',
        'Cut',
        'Copy',
        'Paste',
        'Select All',
        'Reload',
        'Toggle Developer Tools',
        'Toggle Full Screen'
      ])
    )
  })

  it('registers hidden browser navigation menu accelerators', async () => {
    const i18n = await createMainI18n({ locale: 'en' })

    buildAppMenu(i18n)

    const template = buildFromTemplate.mock.calls[0][0] as Array<{
      submenu?: Array<{ label?: string; accelerator?: string; visible?: boolean }>
    }>
    const items = template.flatMap((item) => item.submenu ?? [])

    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Back',
          accelerator: 'CmdOrCtrl+[',
          visible: false
        }),
        expect.objectContaining({
          label: 'Forward',
          accelerator: 'CmdOrCtrl+]',
          visible: false
        })
      ])
    )
  })

  it('routes Edit undo/redo through the renderer instead of native roles', async () => {
    const i18n = await createMainI18n({ locale: 'en' })
    const send = vi.fn()
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue({
      webContents: { isDestroyed: () => false, send }
    } as unknown as Electron.BrowserWindow)

    buildAppMenu(i18n)

    const template = buildFromTemplate.mock.calls[0][0] as Array<{
      submenu?: Array<{
        label?: string
        role?: string
        accelerator?: string
        registerAccelerator?: boolean
        click?: () => void
      }>
    }>
    const items = template.flatMap((item) => item.submenu ?? [])
    const undoItem = items.find((item) => item.label === 'Undo')
    const redoItem = items.find((item) => item.label === 'Redo')

    // Regression: role 'undo'/'redo' drives Chromium's native undo stack, which
    // is empty in the BlockNote editor (Yjs owns history). On Windows/Linux the
    // role's registered accelerator also swallowed Ctrl+Z before the renderer
    // ever saw it, so undo was dead in the editor entirely.
    expect(undoItem).toMatchObject({
      id: 'edit.undo',
      accelerator: 'CmdOrCtrl+Z',
      registerAccelerator: false
    })
    expect(undoItem?.role).toBeUndefined()
    expect(redoItem).toMatchObject({
      id: 'edit.redo',
      accelerator: process.platform === 'win32' ? 'Control+Y' : 'CmdOrCtrl+Shift+Z',
      registerAccelerator: false
    })
    expect(redoItem?.role).toBeUndefined()

    undoItem?.click?.()
    expect(send).toHaveBeenCalledWith(AppChannels.events.MENU_COMMAND, { command: 'edit.undo' })
    redoItem?.click?.()
    expect(send).toHaveBeenCalledWith(AppChannels.events.MENU_COMMAND, { command: 'edit.redo' })
  })

  it('falls back to the sole visible window when no window reports focus', async () => {
    const i18n = await createMainI18n({ locale: 'en' })
    const send = vi.fn()
    const makeWindow = (visible: boolean, sendFn = vi.fn()) =>
      ({
        isVisible: () => visible,
        webContents: { isDestroyed: () => false, send: sendFn }
      }) as unknown as Electron.BrowserWindow
    // Hidden helper windows (PDF export, unopened quick capture) never qualify.
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
      makeWindow(false),
      makeWindow(true, send)
    ])

    buildAppMenu(i18n)

    const undoItem = findMenuItem('Undo')

    // Menu items are clickable while no window has focus (macOS app menu,
    // Linux focus-follows-mouse); the command must not be dropped.
    undoItem?.click?.()
    expect(send).toHaveBeenCalledWith(AppChannels.events.MENU_COMMAND, { command: 'edit.undo' })
  })

  it('drops the command when several visible windows could be the target', async () => {
    const i18n = await createMainI18n({ locale: 'en' })
    const sendA = vi.fn()
    const sendB = vi.fn()
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
      { isVisible: () => true, webContents: { isDestroyed: () => false, send: sendA } },
      { isVisible: () => true, webContents: { isDestroyed: () => false, send: sendB } }
    ] as unknown as Electron.BrowserWindow[])

    buildAppMenu(i18n)

    // Ambiguous target: guessing could undo/close a tab in a window the user
    // isn't looking at, so the command is dropped like before the fallback.
    findMenuItem('Undo')?.click?.()
    expect(sendA).not.toHaveBeenCalled()
    expect(sendB).not.toHaveBeenCalled()
  })

  it('registers native text editing roles and accelerators', async () => {
    const i18n = await createMainI18n({ locale: 'en' })

    buildAppMenu(i18n)

    const template = buildFromTemplate.mock.calls[0][0] as Array<{
      label?: string
      submenu?: Array<{ label?: string; accelerator?: string; role?: string }>
    }>
    const items = template.flatMap((item) => item.submenu ?? [])

    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Cut', role: 'cut' }),
        expect.objectContaining({ label: 'Copy', role: 'copy' }),
        expect.objectContaining({ label: 'Paste', role: 'paste' }),
        expect.objectContaining({
          label: 'Select All',
          role: 'selectAll',
          accelerator: 'CmdOrCtrl+A'
        })
      ])
    )
  })

  it('builds a native editable context menu from edit flags for input targets', async () => {
    const i18n = await createMainI18n({ locale: 'en' })

    const menu = buildEditableTextContextMenu(i18n, {
      isEditable: true,
      formControlType: 'input-text',
      editFlags: {
        canUndo: false,
        canRedo: true,
        canCut: false,
        canCopy: true,
        canPaste: true,
        canSelectAll: true
      }
    })

    expect(menu).toEqual({ template: buildFromTemplate.mock.calls[0][0] })
    expect(buildFromTemplate.mock.calls[0][0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Undo', role: 'undo', enabled: false }),
        expect.objectContaining({ label: 'Redo', role: 'redo', enabled: true }),
        expect.objectContaining({ label: 'Cut', role: 'cut', enabled: false }),
        expect.objectContaining({ label: 'Copy', role: 'copy', enabled: true }),
        expect.objectContaining({ label: 'Paste', role: 'paste', enabled: true }),
        expect.objectContaining({
          label: 'Select All',
          role: 'selectAll',
          accelerator: 'CmdOrCtrl+A',
          enabled: true
        })
      ])
    )
  })

  it('does not build a text context menu for non-editable targets', async () => {
    const i18n = await createMainI18n({ locale: 'en' })

    const menu = buildEditableTextContextMenu(i18n, { isEditable: false })

    expect(menu).toBeNull()
    expect(buildFromTemplate).not.toHaveBeenCalled()
  })

  it('routes contenteditable context-menu undo/redo through the renderer', async () => {
    const i18n = await createMainI18n({ locale: 'en' })
    const send = vi.fn()
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue({
      webContents: { isDestroyed: () => false, send }
    } as unknown as Electron.BrowserWindow)

    buildEditableTextContextMenu(
      i18n,
      {
        isEditable: true,
        formControlType: 'none',
        // Chromium's editFlags describe its native undo stack, which is empty
        // in the BlockNote editor (Yjs owns history) — the Yjs state must win
        // in both directions.
        editFlags: {
          canUndo: false,
          canRedo: true,
          canCut: true,
          canCopy: true,
          canPaste: true,
          canSelectAll: true
        }
      },
      { canUndo: true, canRedo: false }
    )

    const items = buildFromTemplate.mock.calls[0][0] as Array<{
      label?: string
      role?: string
      enabled?: boolean
      click?: () => void
    }>
    const undoItem = items.find((item) => item.label === 'Undo')
    const redoItem = items.find((item) => item.label === 'Redo')

    expect(undoItem?.role).toBeUndefined()
    expect(undoItem?.enabled).toBe(true)
    expect(redoItem?.role).toBeUndefined()
    expect(redoItem?.enabled).toBe(false)

    undoItem?.click?.()
    expect(send).toHaveBeenCalledWith(AppChannels.events.MENU_COMMAND, { command: 'edit.undo' })
    redoItem?.click?.()
    expect(send).toHaveBeenCalledWith(AppChannels.events.MENU_COMMAND, { command: 'edit.redo' })
  })

  it('keeps contenteditable undo/redo enabled when renderer history state is unknown', async () => {
    const i18n = await createMainI18n({ locale: 'en' })

    buildEditableTextContextMenu(i18n, { isEditable: true, formControlType: 'none' })

    const items = buildFromTemplate.mock.calls[0][0] as Array<{
      label?: string
      enabled?: boolean
    }>
    expect(items.find((item) => item.label === 'Undo')?.enabled).toBe(true)
    expect(items.find((item) => item.label === 'Redo')?.enabled).toBe(true)
  })
})

describe('usesRendererHistory', () => {
  it('detects renderer-history targets from formControlType', () => {
    expect(usesRendererHistory({ isEditable: true, formControlType: 'none' })).toBe(true)
    expect(usesRendererHistory({ isEditable: true })).toBe(true)
    expect(usesRendererHistory({ isEditable: true, formControlType: 'input-text' })).toBe(false)
    expect(usesRendererHistory({ isEditable: true, formControlType: 'text-area' })).toBe(false)
    expect(usesRendererHistory({ isEditable: false, formControlType: 'none' })).toBe(false)
  })
})

describe('readRendererHistoryState', () => {
  it('reads the Yjs history state from the renderer', async () => {
    const executeJavaScript = vi.fn().mockResolvedValue({ canUndo: false, canRedo: true })

    await expect(readRendererHistoryState({ executeJavaScript })).resolves.toEqual({
      canUndo: false,
      canRedo: true
    })
    expect(executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('__memryEditorHistoryState')
    )
  })

  it('falls back to enabled items when the renderer cannot answer', async () => {
    // A wrongly greyed Undo is the original bug — unknown state stays enabled.
    await expect(
      readRendererHistoryState({ executeJavaScript: vi.fn().mockRejectedValue(new Error('gone')) })
    ).resolves.toEqual({ canUndo: true, canRedo: true })
    await expect(
      readRendererHistoryState({ executeJavaScript: vi.fn().mockResolvedValue(null) })
    ).resolves.toEqual({ canUndo: true, canRedo: true })
  })
})
