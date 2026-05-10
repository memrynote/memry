import { BrowserWindow } from 'electron'

import { mainToRendererInvoke } from '../../../lib/window-rpc'
import type { CurrentNoteSnapshot } from './handles'

export async function snapshotCurrentNoteFromWindow(
  windowId: string
): Promise<CurrentNoteSnapshot | null> {
  const numericId = Number(windowId)
  if (!Number.isInteger(numericId)) return null

  const win = BrowserWindow.fromId(numericId)
  if (!win) return null

  return mainToRendererInvoke<CurrentNoteSnapshot | null>(
    win,
    'agent_mcp:get_current_note',
    undefined
  )
}
