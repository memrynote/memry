import { and, eq } from 'drizzle-orm'

import { noteFoldChunks } from '@memry/db-schema/index-schema'

import type { IndexDb } from '../database/types'

export interface ChunkCacheKey {
  chunkHash: string
  language: string
  modelId: string
}

const where = (key: ChunkCacheKey) =>
  and(
    eq(noteFoldChunks.chunkHash, key.chunkHash),
    eq(noteFoldChunks.language, key.language),
    eq(noteFoldChunks.modelId, key.modelId)
  )

/** Raw JSON payload of a cached chunk, or null on a miss. Caller validates it. */
export function readChunkPayload(db: IndexDb, key: ChunkCacheKey): string | null {
  const row = db
    .select({ payload: noteFoldChunks.payload })
    .from(noteFoldChunks)
    .where(where(key))
    .get()
  return row?.payload ?? null
}

export function writeChunkPayload(
  db: IndexDb,
  key: ChunkCacheKey,
  payload: string,
  now: number
): void {
  db.insert(noteFoldChunks)
    .values({ ...key, payload, createdAt: now })
    .onConflictDoUpdate({
      target: [noteFoldChunks.chunkHash, noteFoldChunks.language, noteFoldChunks.modelId],
      set: { payload, createdAt: now }
    })
    .run()
}

/** An unreadable cached payload must not block regeneration. */
export function deleteChunkPayload(db: IndexDb, key: ChunkCacheKey): void {
  db.delete(noteFoldChunks).where(where(key)).run()
}
