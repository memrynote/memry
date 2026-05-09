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

import { buildAppMenu } from './menu'

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
})
