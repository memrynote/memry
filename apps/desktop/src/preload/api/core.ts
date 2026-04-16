import { ipcRenderer, webUtils } from 'electron'
import { invoke, subscribe } from '../lib/ipc'

export const windowApi = {
  windowMinimize: (): void => ipcRenderer.send('window-minimize'),
  windowMaximize: (): void => ipcRenderer.send('window-maximize'),
  windowClose: (): void => ipcRenderer.send('window-close')
}

// File drop utility — resolves real filesystem paths from dropped File objects
// (File.path is empty with contextIsolation; webUtils.getPathForFile is the replacement)
export const getFileDropPaths = (files: File[]): string[] =>
  files.map((f) => webUtils.getPathForFile(f))

export type ContextMenuItem = {
  id: string
  label: string
  accelerator?: string
  disabled?: boolean
  type?: 'normal' | 'separator'
}

export const contextMenuApi = (items: ContextMenuItem[]): Promise<string | null> =>
  invoke<string | null>('context-menu:show', items)

export const quickCaptureApi = {
  close: (): void => ipcRenderer.send('quick-capture:close'),
  getClipboard: (): Promise<string> => invoke<string>('quick-capture:get-clipboard'),
  resize: (height: number): void => ipcRenderer.send('quick-capture:resize', height),
  openSettings: (section?: string): void => ipcRenderer.send('quick-capture:open-settings', section)
}

export const flushApi = {
  onFlushRequested: (callback: () => void): (() => void) =>
    subscribe<void>('app:request-flush', () => callback()),
  notifyFlushDone: (): void => {
    ipcRenderer.send('app:flush-done')
  }
}
