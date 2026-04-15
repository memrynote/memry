import { ipcMain } from 'electron'
import type { z } from 'zod'
import { createValidatedHandler, withErrorHandler } from '../validate'

/**
 * Register a Zod-validated IPC command handler.
 *
 * Composes {@link createValidatedHandler} (schema validation) with
 * {@link withErrorHandler} (converts thrown errors into
 * `{ success: false, error }` envelopes) and wires the result to
 * `ipcMain.handle`.
 *
 * Use this for handlers whose existing shape was
 * `createValidatedHandler(schema, withErrorHandler(fn, fallback))`.
 * The `command` callback retains full control over its return shape —
 * this wrapper does not impose an envelope. Return whatever the
 * corresponding contract specifies (e.g. `{ success: true, note }`,
 * `{ success: true }`, etc.).
 *
 * For handlers with no input or a bare `string` input, prefer the
 * existing `createHandler` / `createStringHandler` helpers.
 *
 * @param channel - IPC channel name (from `@memry/contracts`)
 * @param schema - Zod schema validating the handler input
 * @param command - Handler receiving validated input; its return value
 *   is sent to the renderer on success. Thrown errors are caught by
 *   `withErrorHandler` and converted to `{ success: false, error }`.
 * @param fallback - Optional error message used when the caught error
 *   has no `.message`. Defaults to `'Operation failed'`.
 *
 * @example
 * ```typescript
 * registerCommand(
 *   NotesChannels.invoke.CREATE,
 *   NoteCreateSchema,
 *   async (input) => {
 *     const note = await createNoteCommand(input)
 *     return { success: true as const, note }
 *   },
 *   'Failed to create note'
 * )
 * ```
 */
export function registerCommand<TSchema extends z.ZodSchema, TResult>(
  channel: string,
  schema: TSchema,
  command: (input: z.infer<TSchema>) => TResult | Promise<TResult>,
  fallback?: string
): void {
  ipcMain.handle(channel, createValidatedHandler(schema, withErrorHandler(command, fallback)))
}
