import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import type { I18nInstance } from '@memry/i18n/main'

export function buildAppMenu(i18n: I18nInstance): Menu {
  const t = i18n.getFixedT(null, 'menu')

  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [
          {
            label: app.name,
            submenu: [{ role: 'quit' as const }]
          }
        ]
      : []),
    {
      label: t('file.label'),
      submenu: [
        {
          label: t('file.newNote'),
          accelerator: 'CmdOrCtrl+N'
        },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    {
      label: t('edit.label'),
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' }
      ]
    },
    {
      label: t('view.label'),
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ]

  return Menu.buildFromTemplate(template)
}
