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
const isoDateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/

type JsonRecord = Record<string, unknown>

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

async function normalizeDesktopApiArgs(operation: string, args: unknown[]): Promise<unknown[]> {
  switch (operation) {
    case 'calendar.listEvents':
      return [normalizeCalendarListEventsInput(args)]
    case 'calendar.getRange':
      return [await normalizeCalendarRangeInput(args)]
    default:
      return args
  }
}

// Google Workspace Limited Use: Google-synced events are invisible to the agent
// until the user explicitly opts in. Anything other than a stored `true` — not
// asked yet, opted out, or a settings read that failed — stays native-only.
async function hasAgentGoogleEventConsent(): Promise<boolean> {
  try {
    const settings = await window.api.settings.getCalendarGoogleSettings()
    return settings.agentReadEventsConsent === true
  } catch (error) {
    log.warn('Calendar consent lookup failed; keeping agent reads native-only', error)
    return false
  }
}

function normalizeCalendarListEventsInput(args: unknown[]): JsonRecord {
  return objectArg(args[0]) ?? {}
}

async function normalizeCalendarRangeInput(args: unknown[]): Promise<JsonRecord> {
  const input =
    typeof args[0] === 'string' && typeof args[1] === 'string'
      ? { start: args[0], end: args[1] }
      : (objectArg(args[0]) ?? {})
  const start = stringValue(input.startAt, input.start)
  const end = stringValue(input.endAt, input.end)
  return {
    startAt: start ? normalizeCalendarRangeBound(start, 'start') : start,
    endAt: end ? normalizeCalendarRangeBound(end, 'end') : end,
    // Resolved from stored consent, never from the caller: an agent that asks
    // for external events cannot talk its way past the user's answer.
    includeExternal: await hasAgentGoogleEventConsent()
  }
}

function objectArg(value: unknown): JsonRecord | null {
  if (typeof value === 'string') {
    try {
      return objectArg(JSON.parse(value))
    } catch {
      return null
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as JsonRecord
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return undefined
}

function normalizeCalendarRangeBound(value: string, side: 'start' | 'end'): string {
  if (!isoDateOnlyPattern.test(value)) return value
  return localDayIso(side === 'end' ? addLocalDays(value, 1) : value)
}

function localDayIso(value: string): string {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day, 0, 0, 0, 0).toISOString()
}

function addLocalDays(value: string, amount: number): string {
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(year, month - 1, day, 0, 0, 0, 0)
  date.setDate(date.getDate() + amount)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
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
        const args = await normalizeDesktopApiArgs(parsed.data.operation, parsed.data.args)
        const data = await fn(...args)
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
