/**
 * Route an agent canvas write to a renderer window.
 *
 * Element minting needs convertToExcalidrawElements, which exists only in the
 * renderer — so every write goes through a window. The window that has the
 * canvas OPEN is preferred: it applies the change to the live Excalidraw
 * instance instead of a headless read-modify-write, which is what stops the
 * editor's next autosave from silently overwriting the agent (#916 §2e).
 *
 * @module agent/mcp/tools/canvas-write
 */

import { BrowserWindow } from 'electron'
import {
  AgentMcpCanvasWriteChannel,
  type AgentMcpCanvasWriteRequest,
  type AgentMcpCanvasWriteResponse
} from '@memry/contracts/agent-mcp-channels'

import { getCanvasWindowId } from '../../../canvas/live-registry'
import { mainToRendererInvoke } from '../../../lib/window-rpc'
import { AgentToolError } from '../errors'

type OkResponse = Extract<AgentMcpCanvasWriteResponse, { ok: true }>

/**
 * Owner window first, then the calling window, then any live window. A stale
 * registry entry (window gone without a close report) resolves to null here and
 * degrades to the headless path rather than failing the write.
 */
function resolveWindow(canvasId: string, windowId: string | null): BrowserWindow | null {
  const ownerId = getCanvasWindowId(canvasId)
  const owner = ownerId === null ? null : BrowserWindow.fromId(ownerId)
  if (owner) return owner

  const numericId = windowId === null ? Number.NaN : Number(windowId)
  const caller = Number.isInteger(numericId) ? BrowserWindow.fromId(numericId) : null
  if (caller) return caller

  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) ?? null
}

export async function invokeCanvasWrite(
  windowId: string | null,
  request: AgentMcpCanvasWriteRequest
): Promise<OkResponse> {
  const win = resolveWindow(request.canvasId, windowId)
  if (!win) {
    throw new AgentToolError(
      'INTERNAL',
      'Canvas writes need an open memrynote window; none is available.',
      { canvasId: request.canvasId }
    )
  }

  const response = await mainToRendererInvoke<AgentMcpCanvasWriteResponse>(
    win,
    AgentMcpCanvasWriteChannel,
    request,
    // Generous versus the 10s desktop-api budget: a headless write reads,
    // converts and re-serializes a whole scene before it can answer.
    { timeoutMs: 15_000 }
  )

  if (!response) {
    throw new AgentToolError('INTERNAL', 'Canvas write timed out or returned no result.', {
      canvasId: request.canvasId
    })
  }
  if (!response.ok) {
    throw new AgentToolError('INTERNAL', response.error.message, {
      canvasId: request.canvasId,
      code: response.error.code
    })
  }
  return response
}
