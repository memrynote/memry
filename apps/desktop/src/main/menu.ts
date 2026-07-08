import { app, BrowserWindow, dialog, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { AppChannels } from '@memry/contracts/ipc-channels'
import type { I18nInstance } from '@memry/i18n/main'
import { sendAppNavigationDirection } from './app-navigation-command'

const DOCS_URL = 'https://memrynote.com'

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

/** Send a menu command to the focused window's renderer (see use-menu-commands.ts). */
function sendMenuCommand(command: string): void {
  const window = BrowserWindow.getFocusedWindow()
  if (!window || window.webContents.isDestroyed()) return

  window.webContents.send(AppChannels.events.MENU_COMMAND, { command })
}

export function buildAppMenu(i18n: I18nInstance): Menu {
  const t = i18n.getFixedT(null, 'menu')
  const isMac = process.platform === 'darwin'

  // Bridge item: a click that dispatches a command to the renderer. No
  // accelerator — the renderer/editor already owns the shortcuts, so adding one
  // here would double-fire.
  const cmd = (command: string, label: string): MenuItemConstructorOptions => ({
    label,
    click: () => sendMenuCommand(command)
  })

  // Never derive user-facing names from app.name: it resolves to the package
  // name (@memry/desktop) in production and must stay that way — the default
  // userData path is derived from it, so renaming it would strand user data.
  const aboutItem: MenuItemConstructorOptions =
    process.platform === 'win32'
      ? {
          label: t('help.about'),
          click: () =>
            void dialog.showMessageBox({
              type: 'info',
              title: t('help.about'),
              message: 'MemryNote',
              detail: `Version ${app.getVersion()}`
            })
        }
      : { role: 'about', label: t('help.about') }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: 'MemryNote',
            submenu: [
              { role: 'about' as const, label: t('help.about') },
              { type: 'separator' as const },
              cmd('app.preferences', t('app.preferences')),
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { label: t('app.quit'), role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: t('file.label'),
      submenu: [
        cmd('file.newNote', t('file.newNote')),
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
        cmd('file.openQuickly', t('file.openQuickly')),
        { type: 'separator' },
        cmd('file.exportPdf', t('file.exportPdf')),
        { type: 'separator' },
        cmd('file.closeTab', t('file.closeTab')),
        { label: t('file.close'), role: 'close' },
        ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const }])
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
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { label: t('edit.selectAll'), role: 'selectAll', accelerator: 'CmdOrCtrl+A' },
        { type: 'separator' },
        cmd('edit.find', t('edit.find')),
        ...(isMac
          ? [
              { type: 'separator' as const },
              {
                label: t('edit.speech'),
                submenu: [{ role: 'startSpeaking' as const }, { role: 'stopSpeaking' as const }]
              }
            ]
          : [])
      ]
    },
    {
      label: t('insert.label'),
      submenu: [
        cmd('insert.codeBlock', t('insert.codeBlock')),
        cmd('insert.table', t('insert.table')),
        { type: 'separator' },
        cmd('insert.bulletList', t('insert.bulletList')),
        cmd('insert.numberedList', t('insert.numberedList')),
        cmd('insert.taskList', t('insert.taskList')),
        { type: 'separator' },
        cmd('insert.attachment', t('insert.attachment'))
      ]
    },
    {
      label: t('format.label'),
      submenu: [
        cmd('format.heading1', t('format.heading1')),
        cmd('format.heading2', t('format.heading2')),
        cmd('format.heading3', t('format.heading3')),
        cmd('format.body', t('format.body')),
        { type: 'separator' },
        cmd('format.bold', t('format.bold')),
        cmd('format.italic', t('format.italic')),
        cmd('format.code', t('format.code')),
        cmd('format.highlight', t('format.highlight')),
        cmd('format.strikethrough', t('format.strikethrough'))
      ]
    },
    {
      label: t('view.label'),
      submenu: [
        { label: t('view.reload'), role: 'reload' },
        { label: t('view.toggleDevTools'), role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { label: t('view.toggleFullscreen'), role: 'togglefullscreen' },
        { type: 'separator' },
        cmd('view.toggleSidebar', t('view.toggleSidebar')),
        cmd('view.toggleDayPanel', t('view.toggleDayPanel')),
        { type: 'separator' },
        {
          label: t('view.theme'),
          submenu: [
            cmd('view.theme.light', t('view.themeLight')),
            cmd('view.theme.dark', t('view.themeDark')),
            cmd('view.theme.white', t('view.themeWhite')),
            cmd('view.theme.system', t('view.themeSystem'))
          ]
        }
      ]
    },
    { role: 'windowMenu', label: t('window.label') },
    {
      role: 'help',
      label: t('help.label'),
      submenu: [
        ...(isMac ? [] : [aboutItem, { type: 'separator' as const }]),
        { label: t('help.documentation'), click: () => void shell.openExternal(DOCS_URL) },
        cmd('view.shortcuts', t('help.shortcuts'))
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
