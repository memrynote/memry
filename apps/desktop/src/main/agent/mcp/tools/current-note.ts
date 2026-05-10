import { BrowserWindow } from 'electron'

import type { CurrentNoteSnapshot } from './handles'

export async function snapshotCurrentNoteFromWindow(
  windowId: string
): Promise<CurrentNoteSnapshot | null> {
  const numericId = Number(windowId)
  if (!Number.isInteger(numericId)) return null

  const win = BrowserWindow.fromId(numericId)
  if (!win) return null

  const webContents = win.webContents as unknown as {
    invoke?: (channel: string, payload?: unknown) => Promise<CurrentNoteSnapshot | null>
  }

  if (typeof webContents.invoke !== 'function') return null

  return webContents.invoke('agent_mcp:get_current_note', undefined)
}
