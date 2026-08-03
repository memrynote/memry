/**
 * spatialCanvas flag gate for every agent-facing canvas surface.
 *
 * Canvas tools register unconditionally: the MCP tool list is built once at
 * startAgentMcpLifecycle, so gating registration would mean a user who turns
 * the flag on mid-session sees nothing until an app restart. Instead every
 * canvas entry point checks here and fails with an actionable message.
 *
 * The check covers BOTH surfaces — the dedicated vault_*_canvas tools and any
 * `canvas.*` operation reached through the vault_desktop_read/write escape
 * hatch — so there is no gap between them.
 */

import { getFeaturesSettings } from '../../../settings/features'
import { AgentToolError } from '../errors'

export function isCanvasOperation(operation: string): boolean {
  return operation.startsWith('canvas.')
}

export function assertSpatialCanvasEnabled(): void {
  if (getFeaturesSettings().spatialCanvas) return
  throw new AgentToolError(
    'PERMISSION_DENIED',
    'Spatial Canvas is disabled — enable it in Settings → Features.'
  )
}
