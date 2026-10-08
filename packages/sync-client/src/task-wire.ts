export interface TaskJunctions {
  tags: string[]
  linkedNoteIds: string[]
  linkedCanvasIds: string[]
}

/**
 * The one step from a `tasks` row to a `task` sync payload (protocol chapter
 * 13 section 13.7.3). The row is the payload with its junction lists, except
 * that a NULL `fields` column is left out: it means the task holds no field
 * values, and a receiver reads an absent key as "keep yours", never as a clear.
 * `id` and `syncedAt` ride along as the envelope keys receivers ignore.
 */
export function taskRowToWire(
  row: Readonly<Record<string, unknown>>,
  junctions: TaskJunctions
): Record<string, unknown> {
  const { fields, ...columns } = row
  return { ...columns, ...(fields == null ? {} : { fields }), ...junctions }
}
