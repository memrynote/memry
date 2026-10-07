import { BrowserWindow } from 'electron'
import {
  AgentMcpDesktopApiChannel,
  type AgentMcpDesktopApiRequest,
  type AgentMcpDesktopApiResponse
} from '@memry/contracts/agent-mcp-channels'

import { mainToRendererInvoke } from '../../../lib/window-rpc'
import { AgentToolError, isVaultLockRefusalMessage } from '../errors'

export async function invokeDesktopApiFromWindow(
  windowId: string | null,
  request: AgentMcpDesktopApiRequest
): Promise<unknown> {
  if (!windowId) {
    throw new AgentToolError('VALIDATION', 'Desktop API operations require X-Memry-Window header.')
  }

  const numericId = Number(windowId)
  if (!Number.isInteger(numericId)) {
    throw new AgentToolError('VALIDATION', 'Desktop API operation received an invalid window id.', {
      windowId
    })
  }

  const win = BrowserWindow.fromId(numericId)
  if (!win) {
    throw new AgentToolError(
      'VALIDATION',
      'Desktop API operation could not find the memrynote window.',
      {
        windowId
      }
    )
  }

  const response = await mainToRendererInvoke<AgentMcpDesktopApiResponse>(
    win,
    AgentMcpDesktopApiChannel,
    request,
    { timeoutMs: 10_000 }
  )

  if (!response) {
    throw new AgentToolError('INTERNAL', 'Desktop API operation timed out or returned no result.', {
      operation: request.operation
    })
  }

  if (!response.ok) {
    if (isVaultLockRefusalMessage(response.error.message)) {
      throw new AgentToolError('PERMISSION_DENIED', response.error.message, {
        operation: request.operation
      })
    }
    throw new AgentToolError('INTERNAL', response.error.message, {
      operation: request.operation,
      code: response.error.code
    })
  }

  // The notes.* commands report a refused write as a `{ success: false }`
  // envelope instead of throwing; a lock refusal is still a permission error.
  const lockRefusal = vaultLockRefusalOf(response.data)
  if (lockRefusal !== null) {
    throw new AgentToolError('PERMISSION_DENIED', lockRefusal, {
      operation: request.operation
    })
  }

  return response.data
}

function vaultLockRefusalOf(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const { success, error } = data as { success?: unknown; error?: unknown }
  return success === false && typeof error === 'string' && isVaultLockRefusalMessage(error)
    ? error
    : null
}
