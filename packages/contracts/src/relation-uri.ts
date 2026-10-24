/**
 * The `memry://<kind>/<id>` grammar used by relation property values.
 *
 * PERSISTED USER DATA: these strings live in note frontmatter and sync between
 * devices, so the union only ever GROWS. `note`, `task` and `event` parse and
 * serialize exactly as they always have; `canvas`, `journal` and
 * `external-event` were added later. A build that predates a kind parses it to null, which makes the whole
 * property value fail `isRelationValue` and render as plain text — the value is
 * never rewritten or scrubbed, so downgrading and upgrading again is lossless.
 *
 * The id charset is deliberately narrow (`[A-Za-z0-9_-]`). Every identity this
 * grammar carries is already inside it: entity ids are prefixed nanoids, and a
 * journal's identity is its ISO date, whose `-` separators the charset covers.
 * Nothing here is percent-encoded, so nothing here needs decoding. The one
 * exception is `external-event`: a mirrored provider event's row id
 * (`calendar_external_event:<source>:<remote id>`) carries `:`, `@` and `.`,
 * so its id is that row id in unpadded base64url, which fits the charset.
 */
export type RelationKind = 'note' | 'task' | 'event' | 'external-event' | 'canvas' | 'journal'

export interface RelationRef {
  kind: RelationKind
  id: string
}

const RELATION_URI_PATTERN =
  /^memry:\/\/(note|task|event|external-event|canvas|journal)\/([A-Za-z0-9_-]+)$/

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
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- RELATION_URI_PATTERN alternation only matches RelationKind values
  const kind = match[1] as RelationKind
  const id = match[2]
  if (kind === 'journal' && !JOURNAL_DATE_PATTERN.test(id)) return null
  return { kind, id }
}

/** The relation id of a mirrored external event: its row id in unpadded base64url. */
export function encodeExternalEventRelationId(externalEventId: string): string {
  let binary = ''
  for (const byte of new TextEncoder().encode(externalEventId)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The mirrored external event row id a relation id names, or null when it is not base64url. */
export function decodeExternalEventRelationId(relationId: string): string | null {
  try {
    const binary = atob(relationId.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

export function isRelationValue(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.length > 0 && value.every((v) => parseRelationUri(v) !== null)
  )
}

export function parseRelationValue(value: unknown): RelationRef[] {
  if (!isRelationValue(value)) return []
  return value.flatMap((v) => parseRelationUri(v) ?? [])
}
