import { z, ZodError } from 'zod'
import type { IpcMainInvokeEvent } from 'electron'
import { createLogger } from '../lib/logger'
import { getDatabase, type DataDb } from '../database'
import { trackMainError } from '../telemetry/diagnostics'

const ipcLog = createLogger('IPC')

// Every IPC envelope error becomes a telemetry event (→ Loki), throttled to
// one event per error code per window so an error loop can't flood the queue.
const ERROR_TRACK_THROTTLE_MS = 60_000
const lastTrackedByCode = new Map<string, number>()

const trackIpcError = (action: string, error: unknown): void => {
  try {
    const code = error instanceof Error && error.name ? error.name : typeof error
    const now = Date.now()
    const last = lastTrackedByCode.get(code)
    if (last !== undefined && now - last < ERROR_TRACK_THROTTLE_MS) return
    lastTrackedByCode.set(code, now)
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
 * @param handler - Handler function that receives validated input
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
  handler: (input: z.infer<TSchema>) => TResult | Promise<TResult>
): (event: IpcMainInvokeEvent, rawInput: z.input<TSchema>) => Promise<TResult> {
  return async (_event: IpcMainInvokeEvent, rawInput: z.input<TSchema>): Promise<TResult> => {
    try {
      const validated = schema.parse(rawInput)
      return await handler(validated)
    } catch (error) {
      if (error instanceof ZodError) {
        const issues = error.issues ?? (error as { errors?: unknown[] }).errors ?? []
        const messages = (issues as Array<{ path: (string | number)[]; message: string }>)
          .map((e) => `${e.path.join('.')}: ${e.message}`)
          .join(', ')
        throw new Error(`Validation failed: ${messages}`)
      }
      ipcLog.error('handler error:', error)
      throw error instanceof Error ? new Error(error.message) : new Error('Something went wrong')
    }
  }
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
  return async (_event: IpcMainInvokeEvent): Promise<TResult> => {
    return handler()
  }
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
