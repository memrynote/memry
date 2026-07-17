import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserWindow } from 'electron'
import { AppChannels } from '@memry/contracts/ipc-channels'
import { createMainI18n } from '@memry/i18n/main'

const { buildFromTemplate } = vi.hoisted(() => ({
  buildFromTemplate: vi.fn((template: unknown) => ({ template }))
}))

vi.mock('electron', () => ({
  app: { name: 'MemryNote' },
  BrowserWindow: { getFocusedWindow: vi.fn() },
  Menu: { buildFromTemplate }
}))

import { buildAppMenu, buildEditableTextContextMenu } from './menu'

describe('buildAppMenu', () => {
  beforeEach(() => {
    buildFromTemplate.mockClear()
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
      accelerator: 'CmdOrCtrl+Z',
      registerAccelerator: false
    })
    expect(undoItem?.role).toBeUndefined()
    expect(redoItem).toMatchObject({
      accelerator: 'CmdOrCtrl+Shift+Z',
      registerAccelerator: false
    })
    expect(redoItem?.role).toBeUndefined()

    undoItem?.click?.()
    expect(send).toHaveBeenCalledWith(AppChannels.events.MENU_COMMAND, { command: 'edit.undo' })
    redoItem?.click?.()
    expect(send).toHaveBeenCalledWith(AppChannels.events.MENU_COMMAND, { command: 'edit.redo' })
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

  it('builds a native editable context menu from edit flags', async () => {
    const i18n = await createMainI18n({ locale: 'en' })

    const menu = buildEditableTextContextMenu(i18n, {
      isEditable: true,
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
})
