import {
  RecordPullItemResponseSchema,
  type RecordPullItemResponse
} from '@memry/contracts/sync-api'
import type { ItemRef } from './corrupt-item-tracker'

export type ParsedPullBody =
  | { kind: 'not_envelope' }
  | { kind: 'envelope'; items: RecordPullItemResponse[]; invalid: ItemRef[]; unnamed: number }

/**
 * Parses a `/sync/pull` response per item, never per page (protocol 05 §5.14).
 * An item that fails the envelope schema but names an id and type lands in
 * `invalid`; one that names neither is only counted.
 */
export function parsePullItems(body: unknown): ParsedPullBody {
  const rawItems = (body as { items?: unknown } | null)?.items
  if (!Array.isArray(rawItems)) return { kind: 'not_envelope' }

  const items: RecordPullItemResponse[] = []
  const invalid: ItemRef[] = []
  let unnamed = 0
  for (const raw of rawItems) {
    const parsed = RecordPullItemResponseSchema.safeParse(raw)
    if (parsed.success) {
      items.push(parsed.data)
      continue
    }
    const ref = raw as { id?: unknown; type?: unknown } | null
    if (typeof ref?.id === 'string' && typeof ref.type === 'string') {
      invalid.push({ id: ref.id, type: ref.type })
    } else {
      unnamed++
    }
  }
  return { kind: 'envelope', items, invalid, unnamed }
}
