import { useEffect } from 'react'
import { getI18n } from 'react-i18next'
import {
  AgentMcpDesktopApiChannel,
  AgentMcpDesktopApiRequestSchema,
  type AgentMcpDesktopApiResponse
} from '@memry/contracts/agent-mcp-channels'

import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'

const log = createLogger('AgentMcpDesktopApi')

function resolveDesktopApiOperation(operation: string): (...args: unknown[]) => unknown {
  let target: unknown = window.api
  for (const segment of operation.split('.')) {
    if (!target || typeof target !== 'object') {
      throw new Error(`Desktop API operation is unavailable: ${operation}`)
    }
    target = (target as Record<string, unknown>)[segment]
  }

  if (typeof target !== 'function') {
    throw new Error(`Desktop API operation is not callable: ${operation}`)
  }

  return target as (...args: unknown[]) => unknown
}

export function useAgentMcpDesktopApiResponder({
  enabled = true
}: { enabled?: boolean } = {}): void {
  useEffect(() => {
    if (!enabled) return

    return window.api.onMainInvoke(async ({ requestId, channel, payload }) => {
      if (channel !== AgentMcpDesktopApiChannel) return

      const parsed = AgentMcpDesktopApiRequestSchema.safeParse(payload)
      if (!parsed.success) {
        const response: AgentMcpDesktopApiResponse = {
          ok: false,
          error: { code: 'VALIDATION', message: 'Invalid desktop API request.' }
        }
        window.api.respondToMainInvoke(requestId, response)
        return
      }

      try {
        const fn = resolveDesktopApiOperation(parsed.data.operation)
        const data = await fn(...parsed.data.args)
        const response: AgentMcpDesktopApiResponse = { ok: true, data }
        window.api.respondToMainInvoke(requestId, response)
      } catch (error) {
        const message = extractErrorMessage(
          error,
          getI18n().getFixedT(null, 'errors')('generic.operationFailed')
        )
        log.error('Desktop API operation failed', error)
        const response: AgentMcpDesktopApiResponse = {
          ok: false,
          error: { code: 'DESKTOP_API_ERROR', message }
        }
        window.api.respondToMainInvoke(requestId, response)
      }
    })
  }, [enabled])
}
