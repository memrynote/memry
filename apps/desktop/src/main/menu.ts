import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import type { I18nInstance } from '@memry/i18n/main'

export function buildAppMenu(i18n: I18nInstance): Menu {
  const t = i18n.getFixedT(null, 'menu')

  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [
          {
            label: app.name,
            submenu: [{ label: t('app.quit'), role: 'quit' as const }]
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
        { label: t('file.close'), role: 'close' }
      ]
    },
    {
      label: t('edit.label'),
      submenu: [
        { label: t('edit.undo'), role: 'undo' },
        { label: t('edit.redo'), role: 'redo' },
        { type: 'separator' },
        { label: t('edit.cut'), role: 'cut' },
        { label: t('edit.copy'), role: 'copy' },
        { label: t('edit.paste'), role: 'paste' }
      ]
    },
    {
      label: t('view.label'),
      submenu: [
        { label: t('view.reload'), role: 'reload' },
        { label: t('view.toggleDevTools'), role: 'toggleDevTools' },
        { type: 'separator' },
        { label: t('view.toggleFullscreen'), role: 'togglefullscreen' }
      ]
    }
  ]

  return Menu.buildFromTemplate(template)
}
