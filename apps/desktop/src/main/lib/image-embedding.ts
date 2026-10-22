/**
 * Image embeddings, gated by the user's setting.
 *
 * The vision encoder costs a ~109MB download and ~1GB of RAM while loaded, so it
 * is opt-out and never touched by text-only use. Image consumers go through
 * here, not through embeddings.ts, so the setting is enforced in one place.
 *
 * @module main/lib/image-embedding
 */

import { getSetting } from '@main/database/queries/settings'
import { getDatabase } from '../database'
import { generateImageEmbedding } from './embeddings'

const AI_ENABLED_KEY = 'ai.enabled'

/** Stored as 'true' / 'false'. Absent means on: the encoder downloads on first image use. */
export const IMAGE_EMBEDDING_SETTING_KEY = 'ai.imageEmbeddings'

export function isImageEmbeddingEnabled(): boolean {
  try {
    const db = getDatabase()
    return (
      getSetting(db, AI_ENABLED_KEY) !== 'false' &&
      getSetting(db, IMAGE_EMBEDDING_SETTING_KEY) !== 'false'
    )
  } catch {
    return false
  }
}

/** Embed an image file, or null when AI or image embeddings are off or on failure. */
export async function embedImage(image: Uint8Array): Promise<Float32Array | null> {
  if (!isImageEmbeddingEnabled()) return null
  return generateImageEmbedding(image)
}
