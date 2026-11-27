import { CrdtUpdatePackEntryMetaSchema, type PackListResponse } from '@memry/contracts/sync-api'

import { extractEntry, type PackedEntry } from '../services/pack-format'

/**
 * A body reader of protocol 08 §8.4.3 and §8.10 over downloaded packs, shared
 * by the route tests of crdt_update packs and the scoped purge.
 */

export const b64Of = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

export interface Downloaded {
  summary: PackListResponse['packs'][number]
  bytes: Uint8Array
  entries: PackedEntry[]
}

export interface BatchAnswer {
  notes: Record<string, { updates: unknown[]; hasMore: boolean; floor?: number }>
  snapshotMeta: Record<string, { sequenceNum: number; revision: string }>
}

/**
 * A reader of protocol 08 §8.4.3 and §8.10 (Bodies): a packed snapshot is the
 * baseline only when its revision matches `snapshotMeta`, and a packed update
 * applies only above `floor` and at cursor + 1, both read from the batch route
 * after the packs. Answers the body as base64 chunks, or null when the packs
 * do not cover the note and the routes would have to fill a gap.
 */
export const bodyFromPacks = (
  packs: Downloaded[],
  noteId: string,
  answer: BatchAnswer
): string[] | null => {
  const floor = answer.notes[noteId]?.floor
  if (floor === undefined) return null
  const body: string[] = []
  // Below the floor the server holds nothing of this incarnation.
  let cursor = floor
  const meta = answer.snapshotMeta[noteId]
  if (meta) {
    const baseline = packs
      .flatMap((pack) => pack.entries.map((entry) => ({ pack, entry })))
      .find(
        ({ entry }) =>
          entry.kind === 'crdt_snapshot' &&
          entry.id === noteId &&
          entry.meta?.revision === meta.revision
      )
    if (!baseline) return null
    body.push(b64Of(extractEntry(baseline.pack.bytes, baseline.entry)))
    cursor = Math.max(cursor, meta.sequenceNum)
  }
  const updates = packs
    .flatMap((pack) =>
      pack.entries
        .filter((entry) => entry.kind === 'crdt_update' && entry.id === noteId)
        .map((entry) => ({
          meta: CrdtUpdatePackEntryMetaSchema.parse(entry.meta),
          data: b64Of(extractEntry(pack.bytes, entry))
        }))
    )
    .toSorted((a, b) => a.meta.sequenceNum - b.meta.sequenceNum)
  for (const update of updates) {
    if (update.meta.sequenceNum <= cursor || update.meta.sequenceNum <= floor) continue
    if (update.meta.sequenceNum !== cursor + 1) return null
    body.push(update.data)
    cursor++
  }
  return body
}
