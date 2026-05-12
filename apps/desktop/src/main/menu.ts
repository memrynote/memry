import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import type { I18nInstance } from '@memry/i18n/main'
import { sendAppNavigationDirection } from './app-navigation-command'

interface EditableContextMenuParams {
  isEditable?: boolean
  editFlags?: {
    canUndo?: boolean
    canRedo?: boolean
    canCut?: boolean
    canCopy?: boolean
    canPaste?: boolean
    canSelectAll?: boolean
  }
}

function sendNavigationToFocusedWindow(direction: 'back' | 'forward'): void {
  const window = BrowserWindow.getFocusedWindow()
  if (!window || window.webContents.isDestroyed()) return

  sendAppNavigationDirection(window.webContents, direction)
}

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
        {
          label: t('navigation.back'),
          accelerator: 'CmdOrCtrl+[',
          visible: false,
          acceleratorWorksWhenHidden: true,
          click: () => sendNavigationToFocusedWindow('back')
        },
        {
          label: t('navigation.forward'),
          accelerator: 'CmdOrCtrl+]',
          visible: false,
          acceleratorWorksWhenHidden: true,
          click: () => sendNavigationToFocusedWindow('forward')
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
        { label: t('edit.paste'), role: 'paste' },
        { type: 'separator' },
        { label: t('edit.selectAll'), role: 'selectAll', accelerator: 'CmdOrCtrl+A' }
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

export function buildEditableTextContextMenu(
  i18n: I18nInstance,
  params: EditableContextMenuParams
): Menu | null {
  if (!params.isEditable) return null

  const t = i18n.getFixedT(null, 'menu')
  const flags = params.editFlags ?? {}
  const template: MenuItemConstructorOptions[] = [
    { label: t('edit.undo'), role: 'undo', enabled: Boolean(flags.canUndo) },
    { label: t('edit.redo'), role: 'redo', enabled: Boolean(flags.canRedo) },
    { type: 'separator' },
    { label: t('edit.cut'), role: 'cut', enabled: Boolean(flags.canCut) },
    { label: t('edit.copy'), role: 'copy', enabled: Boolean(flags.canCopy) },
    { label: t('edit.paste'), role: 'paste', enabled: Boolean(flags.canPaste) },
    { type: 'separator' },
    {
      label: t('edit.selectAll'),
      role: 'selectAll',
      accelerator: 'CmdOrCtrl+A',
      enabled: Boolean(flags.canSelectAll)
    }
  ]

  return Menu.buildFromTemplate(template)
}
