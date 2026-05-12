import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMainI18n } from '@memry/i18n/main'

const { buildFromTemplate } = vi.hoisted(() => ({
  buildFromTemplate: vi.fn((template: unknown) => ({ template }))
}))

vi.mock('electron', () => ({
  app: { name: 'Memry' },
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
