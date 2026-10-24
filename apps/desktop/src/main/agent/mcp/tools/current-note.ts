import { BrowserWindow } from 'electron'
import {
  AgentMcpInsertAtCursorChannel,
  type AgentMcpInsertAtCursorRequest,
  type AgentMcpInsertAtCursorResponse
} from '@memry/contracts/agent-mcp-channels'

import { mainToRendererInvoke } from '../../../lib/window-rpc'
import { AgentToolError } from '../errors'
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

export async function insertAtCursorInWindow(
  windowId: string | null,
  request: AgentMcpInsertAtCursorRequest
): Promise<void> {
  const numericId = Number(windowId)
  const win = Number.isInteger(numericId) ? BrowserWindow.fromId(numericId) : null
  if (!win) {
    throw new AgentToolError(
      'VALIDATION',
      'No memrynote window is attached to this conversation, so there is no cursor to insert at.',
      { id: request.noteId }
    )
  }

  const response = await mainToRendererInvoke<AgentMcpInsertAtCursorResponse>(
    win,
    AgentMcpInsertAtCursorChannel,
    request
  )
  if (!response) {
    throw new AgentToolError('INTERNAL', 'The editor did not answer the insert request.', {
      id: request.noteId
    })
  }
  if (!response.ok) {
    throw new AgentToolError(
      'VALIDATION',
      `Note ${request.noteId} is not open in an editor. Ask the user to open it, then try again.`,
      { id: request.noteId }
    )
  }
}
