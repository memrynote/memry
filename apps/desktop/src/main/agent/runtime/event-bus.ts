import { BrowserWindow } from 'electron'

import { AgentChannels, type AgentEvent } from '@memry/contracts/ipc-agent'

import { createLogger } from '../../lib/logger'
import { broadcastToAllWindows } from '../../lib/window-broadcast'

const logger = createLogger('AgentEventBus')

/**
 * Which conversation each window currently shows in Agent Chat, keyed by
 * `BrowserWindow.id` (the same id the renderer sends as `sourceWindowId`).
 *
 * A window that has never reported is absent, which is deliberately different
 * from a window that reported `null`: absent means "we do not know", and an
 * unknown window still gets the full stream.
 */
const streamTargetByWindowId = new Map<number, string | null>()

/** Records the conversation `windowId` currently shows; `null` clears it. */
export function setAgentStreamTarget(windowId: number, conversationId: string | null): void {
  streamTargetByWindowId.set(windowId, conversationId)
}

/**
 * Fan an agent event out to the renderer.
 *
 * Every event kind except `assistant_text_delta` goes to all windows: they are
 * per-turn, not per-token, and other windows need them to keep their
 * conversation list and transcript current.
 *
 * `assistant_text_delta` is emitted once per token, and a window that does not
 * show the conversation pays full reducer cost for text it will never render.
 * Those go only to the windows that reported this conversation — with the
 * completed `message_upserted` still broadcast to everyone, so a window that is
 * skipped mid-stream converges on the final text instead of being stranded.
 *
 * If no live window has reported at all (bootstrap race, agent runtime still
 * lazy-starting), targeting would be a guess, so the delta is broadcast exactly
 * as before. That keeps the change additive: streaming can only ever be
 * narrowed by a window that opted in.
 */
export function broadcastAgentEvent(event: AgentEvent): void {
  if (event.kind !== 'assistant_text_delta') {
    broadcastToAllWindows(AgentChannels.events.AGENT_EVENT, event)
    return
  }

  const targets = resolveDeltaTargets(event.conversationId)
  if (targets === null) {
    broadcastToAllWindows(AgentChannels.events.AGENT_EVENT, event)
    return
  }

  for (const win of targets) {
    // A window can die between the liveness check below and this send. Contain
    // that per window: the turn keeps streaming and still persists its message,
    // exactly like broadcastToAllWindows does for the fan-out path.
    try {
      win.webContents.send(AgentChannels.events.AGENT_EVENT, event)
    } catch (err) {
      logger.warn('Failed to deliver an assistant delta to a window:', err)
    }
  }
}

/**
 * Windows that should receive deltas for `conversationId`, or `null` when no
 * live window has reported a target and the caller should broadcast instead.
 *
 * Also prunes entries for windows that no longer exist, so the map cannot grow
 * across a session of opening and closing windows.
 */
function resolveDeltaTargets(conversationId: string): BrowserWindow[] | null {
  const liveWindows = BrowserWindow.getAllWindows().filter((win) => !isUnreachable(win))
  const liveIds = new Set(liveWindows.map((win) => win.id))
  for (const windowId of streamTargetByWindowId.keys()) {
    if (!liveIds.has(windowId)) streamTargetByWindowId.delete(windowId)
  }
  if (streamTargetByWindowId.size === 0) return null

  return liveWindows.filter((win) => streamTargetByWindowId.get(win.id) === conversationId)
}

function isUnreachable(win: BrowserWindow): boolean {
  if (win.isDestroyed()) return true
  return typeof win.webContents.isDestroyed === 'function' && win.webContents.isDestroyed()
}
