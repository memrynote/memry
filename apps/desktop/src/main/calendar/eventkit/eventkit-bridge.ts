import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createLogger } from '../../lib/logger'
import {
  EventKitBridgeError,
  type EventKitAuthorizationStatus,
  type EventKitBridge,
  type EventKitCalendar,
  type EventKitEvent,
  type EventKitEventStatus,
  type EventKitParticipant,
  type ListEventKitEventsInput
} from './eventkit-types'

/**
 * The client for `memry-eventkit`, the Swift helper that reads EventKit
 * (#1405, see `apps/desktop/native/eventkit/README.md`). Never import this
 * module directly: `loadEventKitBridge()` loads it lazily and only on macOS.
 *
 * The helper is spawned on first use and respawned on the next call if it
 * exits. Its stdin is the only thing keeping it alive, so it dies with the app.
 */

const log = createLogger('Calendar:EventKitBridge')

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const AUTHORIZATION_STATUSES: readonly EventKitAuthorizationStatus[] = [
  'not_determined',
  'restricted',
  'denied',
  'write_only',
  'full_access'
]
const EVENT_STATUSES: readonly EventKitEventStatus[] = [
  'none',
  'confirmed',
  'tentative',
  'canceled'
]

export interface EventKitBridgeOptions {
  /** The executable: the helper itself, or a test double. */
  command: string
  args?: string[]
  requestTimeoutMs?: number
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function toStatus(value: unknown): EventKitAuthorizationStatus {
  return AUTHORIZATION_STATUSES.includes(value as EventKitAuthorizationStatus)
    ? (value as EventKitAuthorizationStatus)
    : 'denied'
}

function toCalendar(raw: Record<string, unknown>): EventKitCalendar | null {
  const id = stringOrNull(raw.id)
  if (!id) return null
  return {
    id,
    title: stringOrNull(raw.title) ?? id,
    color: stringOrNull(raw.color),
    type: stringOrNull(raw.type) ?? 'unknown',
    allowsModifications: raw.allowsModifications === true,
    sourceId: stringOrNull(raw.sourceId),
    sourceTitle: stringOrNull(raw.sourceTitle),
    sourceType: stringOrNull(raw.sourceType)
  }
}

function toParticipant(raw: Record<string, unknown>): EventKitParticipant {
  return {
    name: stringOrNull(raw.name),
    email: stringOrNull(raw.email),
    status: stringOrNull(raw.status) ?? 'pending',
    role: stringOrNull(raw.role) ?? 'unknown',
    type: stringOrNull(raw.type) ?? 'unknown',
    isCurrentUser: raw.isCurrentUser === true
  }
}

function toEvent(raw: Record<string, unknown>): EventKitEvent | null {
  const calendarId = stringOrNull(raw.calendarId)
  if (!calendarId) return null
  const status = EVENT_STATUSES.includes(raw.status as EventKitEventStatus)
    ? (raw.status as EventKitEventStatus)
    : 'none'
  return {
    calendarId,
    eventId: stringOrNull(raw.eventId),
    externalId: stringOrNull(raw.externalId),
    title: typeof raw.title === 'string' ? raw.title : '',
    location: stringOrNull(raw.location),
    notes: stringOrNull(raw.notes),
    url: stringOrNull(raw.url),
    isAllDay: raw.isAllDay === true,
    start: stringOrNull(raw.start),
    end: stringOrNull(raw.end),
    timeZone: stringOrNull(raw.timeZone),
    startDate: stringOrNull(raw.startDate),
    lastDate: stringOrNull(raw.lastDate),
    status,
    availability: stringOrNull(raw.availability) ?? 'not_supported',
    isRecurring: raw.isRecurring === true,
    lastModified: stringOrNull(raw.lastModified),
    occurrenceStart: stringOrNull(raw.occurrenceStart),
    attendees: records(raw.attendees).map(toParticipant),
    organizer:
      raw.organizer && typeof raw.organizer === 'object'
        ? toParticipant(raw.organizer as Record<string, unknown>)
        : null,
    alarmMinutes: Array.isArray(raw.alarmMinutes)
      ? raw.alarmMinutes.filter((value): value is number => Number.isFinite(value))
      : [],
    recurrenceRule: stringOrNull(raw.recurrenceRule)
  }
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    : []
}

export function createEventKitBridge(options: EventKitBridgeOptions): EventKitBridge {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const pending = new Map<number, Pending>()
  const listeners = new Set<() => void>()
  let child: ChildProcessWithoutNullStreams | null = null
  let nextId = 1
  let disposed = false

  function failAll(error: EventKitBridgeError): void {
    for (const entry of pending.values()) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
  }

  function onLine(line: string): void {
    if (!line.trim()) return
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      log.warn('Unreadable line from the EventKit helper')
      return
    }
    if (message.event === 'changed') {
      for (const listener of listeners) {
        try {
          listener()
        } catch (error) {
          log.warn('EventKit change listener failed', error)
        }
      }
      return
    }
    if (typeof message.id !== 'number') return
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (entry.timer) clearTimeout(entry.timer)
    const error = message.error as { code?: unknown; message?: unknown } | undefined
    if (error) {
      entry.reject(
        new EventKitBridgeError(
          typeof error.code === 'string' ? error.code : 'helper_error',
          typeof error.message === 'string' ? error.message : undefined
        )
      )
      return
    }
    entry.resolve(message.result)
  }

  function ensureProcess(): ChildProcessWithoutNullStreams {
    if (disposed) throw new EventKitBridgeError('disposed')
    if (child) return child
    const spawned = spawn(options.command, options.args ?? [], { stdio: 'pipe' })
    child = spawned
    createInterface({ input: spawned.stdout }).on('line', onLine)
    spawned.stderr.on('data', (chunk: Buffer) => {
      log.debug('EventKit helper stderr', chunk.toString().trim())
    })
    // A write after the helper died must not surface as an uncaught EPIPE.
    spawned.stdin.on('error', () => undefined)
    const forget = (error: EventKitBridgeError): void => {
      if (child === spawned) child = null
      failAll(error)
    }
    spawned.on('error', (error) => {
      log.warn('EventKit helper could not start', { message: error.message })
      forget(new EventKitBridgeError('helper_unavailable', error.message))
    })
    spawned.on('exit', (code, signal) => {
      if (!disposed) log.info('EventKit helper exited', { code, signal })
      forget(new EventKitBridgeError('helper_exited', `code ${code ?? 'null'}`))
    })
    return spawned
  }

  function request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs: number | null = requestTimeoutMs
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let helper: ChildProcessWithoutNullStreams
      try {
        helper = ensureProcess()
      } catch (error) {
        reject(error instanceof Error ? error : new EventKitBridgeError('helper_unavailable'))
        return
      }
      const id = nextId++
      const timer =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              pending.delete(id)
              reject(new EventKitBridgeError('timeout', method))
            }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      helper.stdin.write(`${JSON.stringify({ id, method, params: params ?? {} })}\n`)
    })
  }

  return {
    async authorizationStatus() {
      return toStatus(await request('authorizationStatus'))
    },
    async requestFullAccess() {
      // The user may leave the system dialog open for as long as they like.
      return toStatus(await request('requestFullAccess', undefined, null))
    },
    async listCalendars() {
      const result = await request('listCalendars')
      return records(result)
        .map(toCalendar)
        .filter((calendar): calendar is EventKitCalendar => calendar !== null)
    },
    async listEvents(input: ListEventKitEventsInput) {
      if (input.calendarIds.length === 0) return []
      const result = await request('listEvents', {
        calendarIds: input.calendarIds,
        start: input.start,
        end: input.end
      })
      return records(result)
        .map(toEvent)
        .filter((event): event is EventKitEvent => event !== null)
    },
    onChanged(listener) {
      listeners.add(listener)
      // Notifications only flow while the helper runs.
      try {
        ensureProcess()
      } catch (error) {
        log.warn('EventKit helper unavailable for change notifications', error)
      }
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      listeners.clear()
      failAll(new EventKitBridgeError('disposed'))
      const running = child
      child = null
      if (running) {
        running.stdin.end()
        running.kill()
      }
    }
  }
}
