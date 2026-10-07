import { z, ZodError } from 'zod'
import type { IpcMainInvokeEvent } from 'electron'
import { toErrorCode } from '@memry/contracts/telemetry-api'
import { createLogger } from '../lib/logger'
import { getDatabase, type DataDb } from '../database'
import { trackMainError } from '../telemetry/diagnostics'
import { isExpectedConditionError } from '../telemetry/expected-conditions'

const ipcLog = createLogger('IPC')

// Every IPC envelope error becomes a telemetry event (→ PostHog), throttled so an
// error loop can't flood the queue. The key must discriminate: keyed only by
// error.name and shared across ALL handlers, one benign recurring "Error"
// masked a genuine different "Error" from another handler for a whole window.
// Keying by action + errorCode keeps the loop protection per failure mode.
const ERROR_TRACK_THROTTLE_MS = 60_000
// The key alphabet is finite in practice (handler names × error codes), but
// `toErrorCode` adopts an error's own `.code`/`.telemetryCode`, so a third-party
// or errno-suffixed code we never anticipated would grow this Map for the life
// of the process. Same cap as telemetry/throttle.ts.
const MAX_TRACKED_ERROR_KEYS = 1000
const lastTrackedByCode = new Map<string, number>()

const sweepTrackedErrorKeys = (now: number): void => {
  if (lastTrackedByCode.size <= MAX_TRACKED_ERROR_KEYS) return
  for (const [key, trackedAt] of lastTrackedByCode) {
    if (now - trackedAt >= ERROR_TRACK_THROTTLE_MS) lastTrackedByCode.delete(key)
  }
  // A burst of more than MAX distinct codes inside a single window leaves
  // nothing expired to sweep, so the oldest-inserted keys are dropped to keep
  // the bound hard. Dropping a key only forfeits its throttle, never an event.
  for (const key of lastTrackedByCode.keys()) {
    if (lastTrackedByCode.size <= MAX_TRACKED_ERROR_KEYS) break
    lastTrackedByCode.delete(key)
  }
}

/**
 * Number of live throttle keys. Exported so the memory bound is directly
 * assertable in tests; production code never reads it.
 */
export const ipcErrorThrottleKeyCount = (): number => lastTrackedByCode.size

// Handlers are registered as `ipcMain.handle(Channel, createValidatedHandler(
// Schema, async (input) => ...))`. An arrow passed straight in as an argument
// has `name === ''`, so EVERY inline handler used to report the same literal
// action (`validated_handler`) and a ZodError could not be pinned to a channel
// — the captured stack only names the bundled wrapper. The channel is known at
// the `ipcMain.handle` registration site and nowhere else, so
// `installIpcChannelLabels` (ipc/lib/ipc-channel-labels.ts) records it here,
// keyed by the wrapper function it was registered with. Weakly held: a listener
// that is removed must not be kept alive by its own label.
const channelByListener = new WeakMap<object, string>()

/**
 * Associate an IPC channel with the wrapper registered on it, so a failure
 * inside that wrapper reports the channel instead of an anonymous label.
 * Called from the `ipcMain.handle` boundary; a no-op for anything else.
 */
export const setIpcHandlerChannel = (listener: unknown, channel: unknown): void => {
  if (typeof listener !== 'function') return
  if (typeof channel !== 'string' || channel.length === 0) return
  channelByListener.set(listener, channel)
}

// Channel first, then the inner handler's own name (named handlers already
// report usefully), then the generic label the wrapper had before.
const handlerAction = (
  listener: object,
  handler: { readonly name: string },
  fallback: string
): string => channelByListener.get(listener) ?? (handler.name || fallback)

const trackIpcError = (action: string, error: unknown): void => {
  try {
    // An expected condition (Ollama not running, an abandoned OAuth flow) is
    // suppressed downstream by trackMainError. Skip it HERE, before the throttle
    // Map — otherwise the suppressed error would still claim and keep refreshing
    // the key, masking a genuine different failure from the same handler.
    if (isExpectedConditionError(error)) return
    const code = `${action}:${toErrorCode(error)}`
    const now = Date.now()
    const last = lastTrackedByCode.get(code)
    if (last !== undefined && now - last < ERROR_TRACK_THROTTLE_MS) return
    lastTrackedByCode.set(code, now)
    sweepTrackedErrorKeys(now)
    // Only the action key and error name/stack leave the process; the envelope
    // `error` message may contain note-derived text and must never be sent.
    trackMainError('ipc', action, error)
  } catch {
    // telemetry must never break the error envelope
  }
}

/**
 * Creates a validated IPC handler that parses input with a Zod schema.
 * Throws an error with validation details if input is invalid.
 *
 * @param schema - Zod schema to validate input against
 * @param handler - Handler function that receives validated input, plus the raw
 *   invoke event for the handlers that need to attribute work to the sender
 *   window (CRDT doc ownership). Handlers that ignore it stay one-parameter.
 * @returns IPC handler function compatible with ipcMain.handle
 *
 * @example
 * ```typescript
 * const CreateNoteSchema = z.object({
 *   title: z.string().min(1),
 *   content: z.string()
 * })
 *
 * ipcMain.handle('notes:create',
 *   createValidatedHandler(CreateNoteSchema, async (input) => {
 *     // input is typed as { title: string, content: string }
 *     return notesService.create(input)
 *   })
 * )
 * ```
 */
export function createValidatedHandler<TSchema extends z.ZodSchema, TResult>(
  schema: TSchema,
  handler: (input: z.infer<TSchema>, event: IpcMainInvokeEvent) => TResult | Promise<TResult>
): (event: IpcMainInvokeEvent, rawInput: z.input<TSchema>) => Promise<TResult> {
  const listener = async (
    event: IpcMainInvokeEvent,
    rawInput: z.input<TSchema>
  ): Promise<TResult> => {
    try {
      const validated = schema.parse(rawInput)
      return await handler(validated, event)
    } catch (error) {
      if (error instanceof ZodError) {
        const issues = error.issues ?? (error as { errors?: unknown[] }).errors ?? []
        const messages = (issues as Array<{ path: (string | number)[]; message: string }>)
          .map((e) => `${e.path.join('.')}: ${e.message}`)
          .join(', ')
        // A validation failure is a renderer↔main contract drift, not user
        // error — worth counting. Only the ZodError name/stack ship, never the
        // issue messages, which can echo input values.
        trackIpcError(handlerAction(listener, handler, 'validated_handler'), error)
        throw new Error(`Validation failed: ${messages}`)
      }
      ipcLog.error('handler error:', error)
      // Handlers on this wrapper (canvas, calendar reads) never pass withDb/
      // withErrorHandler, so this rethrow used to be their ONLY trace.
      trackIpcError(handlerAction(listener, handler, 'validated_handler'), error)
      throw error instanceof Error ? new Error(error.message) : new Error('Something went wrong')
    }
  }
  return listener
}

/**
 * Creates an IPC handler for operations that don't require input validation.
 * Use this for handlers with no input parameters.
 *
 * @param handler - Handler function with no parameters
 * @returns IPC handler function compatible with ipcMain.handle
 *
 * @example
 * ```typescript
 * ipcMain.handle('vault:get-status',
 *   createHandler(async () => {
 *     return vaultService.getStatus()
 *   })
 * )
 * ```
 */
export function createHandler<TResult>(
  handler: () => TResult | Promise<TResult>
): (event: IpcMainInvokeEvent) => Promise<TResult> {
  const listener = async (_event: IpcMainInvokeEvent): Promise<TResult> => {
    try {
      return await handler()
    } catch (error) {
      ipcLog.error('handler error:', error)
      trackIpcError(handlerAction(listener, handler, 'handler'), error)
      throw error
    }
  }
  return listener
}

/**
 * Creates an IPC handler with a simple string parameter.
 * Use this for handlers that take a single string argument.
 *
 * @param handler - Handler function that receives a string
 * @returns IPC handler function compatible with ipcMain.handle
 *
 * @example
 * ```typescript
 * ipcMain.handle('vault:switch',
 *   createStringHandler(async (vaultPath) => {
 *     return vaultService.switch(vaultPath)
 *   })
 * )
 * ```
 */
export function createStringHandler<TResult>(
  handler: (input: string) => TResult | Promise<TResult>
): (event: IpcMainInvokeEvent, rawInput: string) => Promise<TResult> {
  return createValidatedHandler(z.string(), handler)
}

export function withErrorHandler<TArgs extends unknown[], TResult>(
  handler: (...args: TArgs) => TResult | Promise<TResult>,
  fallback = 'errors:generic.operationFailed'
): (...args: TArgs) => Promise<TResult | { success: false; error: string }> {
  return async (...args: TArgs) => {
    try {
      return await handler(...args)
    } catch (error) {
      trackIpcError(handler.name || fallback, error)
      const message = error instanceof Error ? error.message : fallback
      return { success: false, error: message }
    }
  }
}

export function withDb<TArgs extends unknown[], TResult>(
  handler: (db: DataDb, ...args: TArgs) => TResult | Promise<TResult>,
  fallback = 'errors:generic.operationFailed'
): (...args: TArgs) => Promise<TResult | { success: false; error: string }> {
  return async (...args: TArgs) => {
    let db: DataDb
    try {
      db = getDatabase()
    } catch {
      return { success: false, error: 'errors:ipc.noVaultOpen' }
    }
    try {
      return await handler(db, ...args)
    } catch (error) {
      trackIpcError(handler.name || fallback, error)
      const message = error instanceof Error ? error.message : fallback
      return { success: false, error: message }
    }
  }
}
