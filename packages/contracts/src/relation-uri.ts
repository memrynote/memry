/**
 * The `memry://<kind>/<id>` grammar used by relation property values.
 *
 * PERSISTED USER DATA: these strings live in note frontmatter and sync between
 * devices, so the union only ever GROWS. `note`, `task` and `event` parse and
 * serialize exactly as they always have; `canvas` and `journal` were added
 * later. A build that predates a kind parses it to null, which makes the whole
 * property value fail `isRelationValue` and render as plain text — the value is
 * never rewritten or scrubbed, so downgrading and upgrading again is lossless.
 *
 * The id charset is deliberately narrow (`[A-Za-z0-9_-]`). Every identity this
 * grammar carries is already inside it: entity ids are prefixed nanoids, and a
 * journal's identity is its ISO date, whose `-` separators the charset covers.
 * Nothing here is percent-encoded, so nothing here needs decoding.
 */
export type RelationKind = 'note' | 'task' | 'event' | 'canvas' | 'journal'

export interface RelationRef {
  kind: RelationKind
  id: string
}

const RELATION_URI_PATTERN = /^memry:\/\/(note|task|event|canvas|journal)\/([A-Za-z0-9_-]+)$/

/**
 * A journal entry is identified by its local ISO date, not by a row id: the
 * date is what survives re-indexing, a vault copy and another device, and it is
 * what the journal tab needs to open the right day. Shape-checked here so a
 * malformed date is rejected at the boundary rather than opening an Invalid
 * Date downstream.
 */
const JOURNAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function formatRelationUri(kind: RelationKind, id: string): string {
  return `memry://${kind}/${id}`
}

export function parseRelationUri(value: unknown): RelationRef | null {
  if (typeof value !== 'string') return null
  const match = RELATION_URI_PATTERN.exec(value)
  if (!match) return null
  const kind = match[1] as RelationKind
  const id = match[2]
  if (kind === 'journal' && !JOURNAL_DATE_PATTERN.test(id)) return null
  return { kind, id }
}

export function isRelationValue(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.length > 0 && value.every((v) => parseRelationUri(v) !== null)
  )
}

export function parseRelationValue(value: unknown): RelationRef[] {
  if (!isRelationValue(value)) return []
  return value.map((v) => parseRelationUri(v) as RelationRef)
}
