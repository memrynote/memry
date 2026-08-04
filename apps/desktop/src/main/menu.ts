import { app, BrowserWindow, dialog, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { AppChannels } from '@memry/contracts/ipc-channels'
import type { I18nInstance } from '@memry/i18n/main'
import { sendAppNavigationDirection } from './app-navigation-command'

const DOCS_URL = 'https://docs.memrynote.com'

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

/**
 * Menu items stay clickable while no window reports focus (macOS app menu
 * without a focused window, Linux focus-follows-mouse). Fall back to the app
 * window only when it is unambiguous: exactly one visible live window.
 * Hidden helper windows (PDF export, unopened quick capture) never qualify,
 * and with several visible windows we drop the command rather than guess.
 */
function resolveMenuTargetWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.webContents.isDestroyed()) return focused

  const visible = BrowserWindow.getAllWindows().filter(
    (candidate) => candidate.isVisible() && !candidate.webContents.isDestroyed()
  )
  return visible.length === 1 ? visible[0] : null
}

function sendNavigationToFocusedWindow(direction: 'back' | 'forward'): void {
  const window = resolveMenuTargetWindow()
  if (!window) return

  sendAppNavigationDirection(window.webContents, direction)
}

/** Send a menu command to the target window's renderer (see use-menu-commands.ts). */
function sendMenuCommand(command: string): void {
  const window = resolveMenuTargetWindow()
  if (!window) return

  window.webContents.send(AppChannels.events.MENU_COMMAND, { command })
}

export function buildAppMenu(i18n: I18nInstance): Menu {
  const t = i18n.getFixedT(null, 'menu')
  const isMac = process.platform === 'darwin'

  // Bridge item: a click that dispatches a command to the renderer. When an
  // accelerator is given it is display-only (registerAccelerator: false) — the
  // renderer/editor owns the shortcut, so registering it here would swallow the
  // keydown in the main process on Windows/Linux before the editor sees it.
  const cmd = (
    command: string,
    label: string,
    accelerator?: string
  ): MenuItemConstructorOptions => ({
    id: command,
    label,
    ...(accelerator ? { accelerator, registerAccelerator: false } : {}),
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
              detail: t('help.aboutVersion', { version: app.getVersion() })
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
              { role: 'services' as const, label: t('app.services') },
              { type: 'separator' as const },
              // Same app.name trap as About: the hide role's default label is
              // `Hide ${app.name}`, which reads "Hide @memry/desktop" in production.
              { role: 'hide' as const, label: t('app.hide') },
              { role: 'hideOthers' as const, label: t('app.hideOthers') },
              { role: 'unhide' as const, label: t('app.unhide') },
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
        cmd('file.closeTab', t('file.closeTab'), 'CmdOrCtrl+W'),
        // Not role 'close': a role defaults its accelerator to CmdOrCtrl+W, and
        // registerAccelerator only suppresses that on Windows/Linux — so on macOS
        // the role owned ⌘W and closed the window instead of the active tab. The
        // renderer decides (tab close, or window close once only Home is left) and
        // closes through the IPC path that flushes pending work first.
        cmd('file.closeWindow', t('file.close')),
        // Windows names this command "Exit", every other platform "Quit" — the
        // role default did the same split, so the label keeps both wordings.
        ...(isMac
          ? []
          : [
              { type: 'separator' as const },
              {
                label: process.platform === 'win32' ? t('app.exit') : t('app.quit'),
                role: 'quit' as const
              }
            ])
      ]
    },
    {
      label: t('edit.label'),
      submenu: [
        // Not role 'undo'/'redo': the role drives Chromium's native undo stack,
        // which is empty in the BlockNote editor (Yjs owns history), and on
        // Windows/Linux the role's registered accelerator swallows Ctrl+Z in the
        // main process before the editor keymap ever sees it. The cmd() bridge
        // shows the shortcut without registering it. Windows redo follows the
        // platform's Ctrl+Y convention like the role did.
        cmd('edit.undo', t('edit.undo'), 'CmdOrCtrl+Z'),
        cmd(
          'edit.redo',
          t('edit.redo'),
          process.platform === 'win32' ? 'Control+Y' : 'CmdOrCtrl+Shift+Z'
        ),
        { type: 'separator' },
        { label: t('edit.cut'), role: 'cut' },
        { label: t('edit.copy'), role: 'copy' },
        { label: t('edit.paste'), role: 'paste' },
        { label: t('edit.pasteAndMatchStyle'), role: 'pasteAndMatchStyle' },
        { label: t('edit.delete'), role: 'delete' },
        { label: t('edit.selectAll'), role: 'selectAll', accelerator: 'CmdOrCtrl+A' },
        { type: 'separator' },
        cmd('edit.find', t('edit.find')),
        ...(isMac
          ? [
              { type: 'separator' as const },
              {
                label: t('edit.speech'),
                submenu: [
                  { role: 'startSpeaking' as const, label: t('edit.startSpeaking') },
                  { role: 'stopSpeaking' as const, label: t('edit.stopSpeaking') }
                ]
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
        { label: t('view.actualSize'), role: 'resetZoom' },
        { label: t('view.zoomIn'), role: 'zoomIn' },
        { label: t('view.zoomOut'), role: 'zoomOut' },
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
    {
      role: 'windowMenu',
      label: t('window.label'),
      // The role's own children (Minimize / Zoom / Bring All to Front / Close)
      // carry Electron's English labels, so they are spelled out here instead:
      // same items, same roles, same platform split as the role default.
      submenu: [
        { role: 'minimize' as const, label: t('window.minimize') },
        { role: 'zoom' as const, label: t('window.zoom') },
        ...(isMac
          ? [{ type: 'separator' as const }, { role: 'front' as const, label: t('window.front') }]
          : [{ role: 'close' as const, label: t('window.close') }])
      ]
    },
    {
      role: 'help',
      label: t('help.label'),
      submenu: [
        ...(isMac ? [] : [aboutItem, { type: 'separator' as const }]),
        // F1 registers as a real accelerator (default registerAccelerator: true):
        // the action lives here in the main process, so unlike the renderer-owned
        // cmd() items there is no editor keydown to swallow. Opening the docs is
        // always safe, and the menu now surfaces F1 for discoverability.
        {
          label: t('help.documentation'),
          accelerator: 'F1',
          click: () => void shell.openExternal(DOCS_URL)
        },
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
