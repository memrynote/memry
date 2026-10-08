export interface TaskJunctions {
  tags: string[]
  linkedNoteIds: string[]
  linkedCanvasIds: string[]
}

/** Chapter 13 §13.7.3.1: a NULL `fields` column is left out. */
export function taskRowToWire(
  row: Readonly<Record<string, unknown>>,
  junctions: TaskJunctions
): Record<string, unknown> {
  const { fields, ...columns } = row
  return { ...columns, ...(fields == null ? {} : { fields }), ...junctions }
}
