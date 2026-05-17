import { BrowserWindow } from 'electron'
import {
  AgentMcpDesktopApiChannel,
  type AgentMcpDesktopApiRequest,
  type AgentMcpDesktopApiResponse
} from '@memry/contracts/agent-mcp-channels'

import { mainToRendererInvoke } from '../../../lib/window-rpc'
import { AgentToolError } from '../errors'

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
    throw new AgentToolError('INTERNAL', response.error.message, {
      operation: request.operation,
      code: response.error.code
    })
  }

  return response.data
}
