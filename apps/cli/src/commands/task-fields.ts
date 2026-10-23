/**
 * Flag parsing for the task fields the CLI lacked: `--duration`, `--link-canvas` and
 * `--field name=value`. Validation follows desktop's TaskCreateSchema and
 * TaskFieldsSchema, so the CLI accepts exactly what the app accepts.
 */
import { TaskFieldsSchema } from '@memry/contracts/tasks-api'
import type { JsonValue } from '@memry/shared/versioned'
import { getFlag, getFlagList, hasFlag, parseCliValue } from '../run.ts'

/** `--duration <minutes>`: a positive whole number, or `null` to clear (update only). */
export function parseDurationFlag(flags: Map<string, string[]>): number | null | undefined {
  if (!hasFlag(flags, 'duration')) return undefined
  const raw = getFlag(flags, 'duration')
  if (raw === 'null') return null
  const minutes = Number(raw)
  if (!Number.isInteger(minutes) || minutes <= 0) {
    throw new Error(`Invalid --duration: ${raw}. Use a positive whole number of minutes`)
  }
  return minutes
}

/**
 * `--field name=value`, repeatable. A value is read as JSON when it parses (`3`, `true`,
 * `null`, `["a","b"]`) and as text otherwise. On update `name=null` removes the field.
 */
export function parseFieldFlags(
  flags: Map<string, string[]>
): Record<string, JsonValue> | undefined {
  const entries = getFlagList(flags, 'field')
  if (entries.length === 0) return undefined
  const fields: Record<string, unknown> = {}
  for (const entry of entries) {
    const at = entry.indexOf('=')
    if (at <= 0) throw new Error(`Invalid --field: ${entry}. Use name=value`)
    fields[entry.slice(0, at)] = parseCliValue(entry.slice(at + 1))
  }
  const parsed = TaskFieldsSchema.safeParse(fields)
  if (!parsed.success) {
    throw new Error(
      `Invalid --field: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`
    )
  }
  return parsed.data as Record<string, JsonValue>
}
