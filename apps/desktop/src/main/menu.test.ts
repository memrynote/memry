import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserWindow } from 'electron'
import { AppChannels } from '@memry/contracts/ipc-channels'
import { createMainI18n } from '@memry/i18n/main'

const { buildFromTemplate, openExternal } = vi.hoisted(() => ({
  buildFromTemplate: vi.fn((template: unknown) => ({ template })),
  openExternal: vi.fn()
}))

vi.mock('electron', () => ({
  app: { name: 'MemryNote' },
  BrowserWindow: { getFocusedWindow: vi.fn(), getAllWindows: vi.fn(() => []) },
  Menu: { buildFromTemplate },
  shell: { openExternal }
}))

import { buildAppMenu, buildEditableTextContextMenu } from './menu'

interface TemplateItem {
  label?: string
  role?: string
  type?: string
  enabled?: boolean
  accelerator?: string
  registerAccelerator?: boolean
  id?: string
  click?: () => void
  submenu?: TemplateItem[]
}

function createWebContents() {
  return {
    replaceMisspelling: vi.fn(),
    session: { addWordToSpellCheckerDictionary: vi.fn() }
  } as unknown as Electron.WebContents & {
    replaceMisspelling: ReturnType<typeof vi.fn>
    session: { addWordToSpellCheckerDictionary: ReturnType<typeof vi.fn> }
  }
}

/** Find an item by label in the most recently built template. */
function findMenuItem(label: string): TemplateItem | undefined {
  const template = buildFromTemplate.mock.calls.at(-1)?.[0] as TemplateItem[]
  return template.flatMap((item) => item.submenu ?? []).find((item) => item.label === label)
}

describe('buildAppMenu', () => {
  beforeEach(() => {
    buildFromTemplate.mockClear()
    openExternal.mockClear()
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

  it('opens the online docs from Help → Documentation via F1', async () => {
    const i18n = await createMainI18n({ locale: 'en' })

    buildAppMenu(i18n)

    const docs = findMenuItem('Documentation')
    // The action lives in the main process (shell.openExternal), so unlike the
    // renderer-owned cmd() items this accelerator registers and fires F1 directly.
    expect(docs).toMatchObject({ accelerator: 'F1' })

    docs?.click?.()
    expect(openExternal).toHaveBeenCalledWith('https://docs.memrynote.com')
  })

  it('offers Check for Updates… on every platform and routes it to the renderer', async () => {
    const i18n = await createMainI18n({ locale: 'en' })
    const send = vi.fn()
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue({
      webContents: { isDestroyed: () => false, send }
    } as unknown as Electron.BrowserWindow)

    buildAppMenu(i18n)

    // macOS puts it in the app menu, Windows/Linux in Help — either way it sits
    // in the built template and dispatches the same renderer command.
    const item = findMenuItem('Check for Updates…')
    expect(item).toMatchObject({ id: 'app.checkForUpdates' })

    item?.click?.()
    expect(send).toHaveBeenCalledWith(AppChannels.events.MENU_COMMAND, {
      command: 'app.checkForUpdates'
    })
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

  it('routes View zoom through the renderer instead of native roles', async () => {
    const i18n = await createMainI18n({ locale: 'en' })
    const send = vi.fn()
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue({
      webContents: { isDestroyed: () => false, send }
    } as unknown as Electron.BrowserWindow)

    buildAppMenu(i18n)

    const zoomIn = findMenuItem('Zoom In')
    const zoomOut = findMenuItem('Zoom Out')
    const actualSize = findMenuItem('Actual Size')

    // Regression: these were roles 'zoomIn'/'zoomOut'/'resetZoom', which mutate
    // webContents.zoomFactor directly. Kept alongside the persisted setting they
    // would be a second writer, and the stored factor would drift from what the
    // user actually sees. window-zoom.ts has to stay the only writer.
    expect(zoomIn).toMatchObject({
      id: 'view.zoomIn',
      accelerator: 'CmdOrCtrl+Plus',
      registerAccelerator: false
    })
    expect(zoomIn?.role).toBeUndefined()
    expect(zoomOut).toMatchObject({
      id: 'view.zoomOut',
      accelerator: 'CmdOrCtrl+-',
      registerAccelerator: false
    })
    expect(zoomOut?.role).toBeUndefined()
    expect(actualSize).toMatchObject({
      id: 'view.actualSize',
      accelerator: 'CmdOrCtrl+0',
      registerAccelerator: false
    })
    expect(actualSize?.role).toBeUndefined()

    zoomIn?.click?.()
    expect(send).toHaveBeenCalledWith(AppChannels.events.MENU_COMMAND, { command: 'view.zoomIn' })
    zoomOut?.click?.()
    expect(send).toHaveBeenCalledWith(AppChannels.events.MENU_COMMAND, { command: 'view.zoomOut' })
    actualSize?.click?.()
    expect(send).toHaveBeenCalledWith(AppChannels.events.MENU_COMMAND, {
      command: 'view.actualSize'
    })
  })

  it('never ships a native zoom role in any menu', async () => {
    const i18n = await createMainI18n({ locale: 'en' })

    buildAppMenu(i18n)

    const template = buildFromTemplate.mock.calls.at(-1)?.[0] as TemplateItem[]
    const roles = template
      .flatMap((item) => item.submenu ?? [])
      .flatMap((item) => [item, ...(item.submenu ?? [])])
      .map((item) => item.role)

    expect(roles).not.toContain('zoomIn')
    expect(roles).not.toContain('zoomOut')
    expect(roles).not.toContain('resetZoom')
  })

  it('gives ⌘W to Close Tab and routes Close Window through the renderer', async () => {
    const i18n = await createMainI18n({ locale: 'en' })
    const send = vi.fn()
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue({
      webContents: { isDestroyed: () => false, send }
    } as unknown as Electron.BrowserWindow)

    buildAppMenu(i18n)

    const closeTab = findMenuItem('Close Tab')
    const closeWindow = findMenuItem('Close Window')

    expect(closeTab).toMatchObject({
      id: 'file.closeTab',
      accelerator: 'CmdOrCtrl+W',
      registerAccelerator: false
    })

    // Regression: role 'close' defaults its accelerator to CmdOrCtrl+W, and
    // registerAccelerator is Linux/Windows-only — so on macOS the role stole ⌘W
    // from the tab system and closed the whole window instead of the tab.
    expect(closeWindow?.role).toBeUndefined()
    expect(closeWindow?.accelerator).toBeUndefined()

    closeTab?.click?.()
    expect(send).toHaveBeenCalledWith(AppChannels.events.MENU_COMMAND, { command: 'file.closeTab' })
    closeWindow?.click?.()
    expect(send).toHaveBeenCalledWith(AppChannels.events.MENU_COMMAND, {
      command: 'file.closeWindow'
    })
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

  it('labels the role items that would otherwise render Electron defaults', async () => {
    const i18n = await createMainI18n({ locale: 'en' })

    buildAppMenu(i18n)

    // Regression: a role without a label renders Electron's own English string
    // ("Actual Size", "Minimize", …) right next to translated siblings. The role
    // stays — it provides the behaviour — and the label only names it.
    expect(findMenuItem('Paste and Match Style')).toMatchObject({ role: 'pasteAndMatchStyle' })
    expect(findMenuItem('Delete')).toMatchObject({ role: 'delete' })
    // Actual Size / Zoom In / Zoom Out used to be roles here. They now route to
    // the renderer so window-zoom.ts stays the only writer of zoomFactor; the
    // two tests above own that ground.

    // macOS app menu only. Same app.name trap as About: the hide role's default
    // label is `Hide ${app.name}`, which reads "Hide @memry/desktop" in production.
    if (process.platform === 'darwin') {
      expect(findMenuItem('Hide MemryNote')).toMatchObject({ role: 'hide' })
    }

    // The windowMenu role's children are Electron defaults too, so the submenu is
    // spelled out with labelled items while the role itself is left intact.
    const template = buildFromTemplate.mock.calls.at(-1)?.[0] as TemplateItem[]
    expect(template.find((item) => item.label === 'Window')).toMatchObject({ role: 'windowMenu' })
    expect(findMenuItem('Minimize')).toMatchObject({ role: 'minimize' })
    expect(findMenuItem('Zoom')).toMatchObject({ role: 'zoom' })
  })

  it('builds a native editable context menu from edit flags', async () => {
    const i18n = await createMainI18n({ locale: 'en' })

    const menu = buildEditableTextContextMenu(
      i18n,
      {
        isEditable: true,
        editFlags: {
          canUndo: false,
          canRedo: true,
          canCut: false,
          canCopy: true,
          canPaste: true,
          canSelectAll: true
        }
      },
      createWebContents()
    )

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

    const menu = buildEditableTextContextMenu(i18n, { isEditable: false }, createWebContents())

    expect(menu).toBeNull()
    expect(buildFromTemplate).not.toHaveBeenCalled()
  })

  it('offers spelling suggestions above the edit items and applies the picked one', async () => {
    const i18n = await createMainI18n({ locale: 'en' })
    const webContents = createWebContents()

    buildEditableTextContextMenu(
      i18n,
      {
        isEditable: true,
        misspelledWord: 'recieve',
        dictionarySuggestions: ['receive', 'reprieve'],
        editFlags: { canPaste: true }
      },
      webContents
    )

    const template = buildFromTemplate.mock.calls.at(-1)?.[0] as TemplateItem[]
    expect(template.slice(0, 5)).toEqual([
      expect.objectContaining({ label: 'receive' }),
      expect.objectContaining({ label: 'reprieve' }),
      { type: 'separator' },
      expect.objectContaining({ label: 'Add to Dictionary' }),
      { type: 'separator' }
    ])
    expect(template[5]).toMatchObject({ label: 'Undo', role: 'undo' })

    template[1].click?.()
    expect(webContents.replaceMisspelling).toHaveBeenCalledWith('reprieve')

    template[3].click?.()
    expect(webContents.session.addWordToSpellCheckerDictionary).toHaveBeenCalledWith('recieve')
  })

  it('shows a disabled placeholder when the dictionary has no suggestions', async () => {
    const i18n = await createMainI18n({ locale: 'en' })

    buildEditableTextContextMenu(
      i18n,
      { isEditable: true, misspelledWord: 'qwertyu', dictionarySuggestions: [], editFlags: {} },
      createWebContents()
    )

    const template = buildFromTemplate.mock.calls.at(-1)?.[0] as TemplateItem[]
    expect(template.slice(0, 4)).toEqual([
      { label: 'No Suggestions', enabled: false },
      { type: 'separator' },
      expect.objectContaining({ label: 'Add to Dictionary' }),
      { type: 'separator' }
    ])
  })

  it('leaves the context menu untouched when the word is spelled correctly', async () => {
    const i18n = await createMainI18n({ locale: 'en' })

    buildEditableTextContextMenu(
      i18n,
      { isEditable: true, misspelledWord: '', dictionarySuggestions: [], editFlags: {} },
      createWebContents()
    )

    const template = buildFromTemplate.mock.calls.at(-1)?.[0] as TemplateItem[]
    expect(template[0]).toMatchObject({ label: 'Undo', role: 'undo' })
    expect(template.map((item) => item.label)).not.toContain('Add to Dictionary')
  })
})
