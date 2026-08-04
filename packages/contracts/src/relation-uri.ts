export type RelationKind = 'note' | 'task' | 'event'

export interface RelationRef {
  kind: RelationKind
  id: string
}

const RELATION_URI_PATTERN = /^memry:\/\/(note|task|event)\/([A-Za-z0-9_-]+)$/

export function formatRelationUri(kind: RelationKind, id: string): string {
  return `memry://${kind}/${id}`
}

export function parseRelationUri(value: unknown): RelationRef | null {
  if (typeof value !== 'string') return null
  const match = RELATION_URI_PATTERN.exec(value)
  if (!match) return null
  return { kind: match[1] as RelationKind, id: match[2] }
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
