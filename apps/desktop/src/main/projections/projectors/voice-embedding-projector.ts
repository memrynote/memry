import { and, eq } from 'drizzle-orm'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import { getSetting } from '@main/database/queries/settings'
import { getDatabase, getRawIndexDatabase } from '../../database'
import {
  deleteVoiceVectors,
  readVoiceVectorStates,
  replaceVoiceVectors,
  type VoiceVectorSource
} from '../../database/voice-vectors'
import {
  decodeWavForEmbedding,
  embedAudio,
  isAudioEmbeddingEnabled
} from '../../lib/audio-embedding'
import { buildEmbeddingInput, EMBEDDING_INPUT_VERSION } from '../../lib/embedding-input'
import { generateEmbedding, initEmbeddingModel, isModelLoaded } from '../../lib/embeddings'
import { createLogger } from '../../lib/logger'
import { openVaultFile } from '../../lib/paths'
import type { ProjectionEvent, ProjectionProjector } from '../types'

const logger = createLogger('Projections:VoiceEmbeddings')

const AI_SETTINGS_KEY = 'ai.enabled'

/** Bump when how a recording is windowed or encoded changes, so its vectors are rebuilt. */
export const AUDIO_EMBEDDING_INPUT_VERSION = 1

/** Words a transcript needs to stand in for the recording; Whisper turns silence and noise into one or two. */
const MIN_TRANSCRIPT_WORDS = 3

interface VoiceItem {
  id: string
  title: string
  transcription: string | null
  transcriptionStatus: string | null
  attachmentPath: string | null
}

/**
 * How a voice memo is indexed. Measured on recordings (see the PR): a typed
 * query finds speech as well through its transcript as through its audio, and
 * a spoken query finds it better, so a memo with a usable transcript is embedded
 * from the transcript with the text model alone. A memo with no usable
 * transcript (failed, never requested, silence, music, other sounds) is
 * embedded from its audio, the only signal it has. `wait` is a transcription
 * still running: its completion publishes `inbox.upserted` again.
 */
export type VoiceEmbeddingPlan = { source: VoiceVectorSource; text?: string } | 'wait'

export function planVoiceEmbedding(item: VoiceItem): VoiceEmbeddingPlan {
  if (item.transcriptionStatus === 'pending' || item.transcriptionStatus === 'processing') {
    return 'wait'
  }
  const words = item.transcription?.match(/\p{L}[\p{L}\p{N}']*/gu)?.length ?? 0
  if (item.transcriptionStatus === 'complete' && words >= MIN_TRANSCRIPT_WORDS) {
    return {
      source: 'transcript',
      text: buildEmbeddingInput({ title: item.title, content: item.transcription })
    }
  }
  return { source: 'audio' }
}

function inputVersion(source: VoiceVectorSource): number {
  return source === 'audio' ? AUDIO_EMBEDDING_INPUT_VERSION : EMBEDDING_INPUT_VERSION
}

function isAIEnabled(): boolean {
  try {
    return getSetting(getDatabase(), AI_SETTINGS_KEY) !== 'false'
  } catch {
    return false
  }
}

function readVoiceItems(itemId?: string): VoiceItem[] {
  return getDatabase()
    .select({
      id: inboxItems.id,
      title: inboxItems.title,
      transcription: inboxItems.transcription,
      transcriptionStatus: inboxItems.transcriptionStatus,
      attachmentPath: inboxItems.attachmentPath
    })
    .from(inboxItems)
    .where(and(eq(inboxItems.type, 'voice'), itemId ? eq(inboxItems.id, itemId) : undefined))
    .all()
}

async function readRecording(
  vaultPath: string,
  attachmentPath: string
): Promise<Float32Array | null> {
  if (!attachmentPath.toLowerCase().endsWith('.wav')) return null
  const handle = await openVaultFile(vaultPath, attachmentPath)
  if (handle === null) return null
  try {
    return decodeWavForEmbedding(await handle.readFile())
  } finally {
    await handle.close()
  }
}

export function createVoiceEmbeddingProjector(
  getVaultPath: () => string | null
): ProjectionProjector {
  /** Embed one memo as `plan` says. Returns whether vectors were written. */
  const embedItem = async (item: VoiceItem, plan: VoiceEmbeddingPlan): Promise<boolean> => {
    const vaultPath = getVaultPath()
    if (plan === 'wait' || !vaultPath) return false
    const db = getRawIndexDatabase()

    if (plan.source === 'transcript') {
      if (!plan.text) return false
      if (!isModelLoaded() && !(await initEmbeddingModel())) return false
      const vector = await generateEmbedding(plan.text)
      if (!vector) return false
      replaceVoiceVectors(db, item.id, 'transcript', inputVersion('transcript'), [vector])
      return true
    }

    if (!item.attachmentPath || !isAudioEmbeddingEnabled()) return false
    const samples = await readRecording(vaultPath, item.attachmentPath)
    if (!samples) return false
    const vectors = await embedAudio(samples)
    if (!vectors || vectors.length === 0) return false
    replaceVoiceVectors(db, item.id, 'audio', inputVersion('audio'), vectors)
    return true
  }

  return {
    name: 'voice-embedding',

    // Model loads and encoder runs are slow and nothing reads them back in the
    // same turn (see the embedding projector).
    background: true,

    handles(event: ProjectionEvent): boolean {
      return event.type === 'inbox.upserted' || event.type === 'inbox.deleted'
    },

    async project(event: ProjectionEvent): Promise<void> {
      if (event.type === 'inbox.deleted') {
        deleteVoiceVectors(getRawIndexDatabase(), event.itemId)
        return
      }
      if (event.type !== 'inbox.upserted') return

      const [item] = readVoiceItems(event.itemId)
      if (!item) return
      if (!isAIEnabled()) {
        deleteVoiceVectors(getRawIndexDatabase(), item.id)
        return
      }
      try {
        await embedItem(item, planVoiceEmbedding(item))
      } catch (error) {
        logger.warn('Failed to embed voice memo', { itemId: item.id, error })
      }
    },

    /** Vectors are derived: drop them and let reconcile refill from the inbox. */
    async rebuild(): Promise<void> {
      const db = getRawIndexDatabase()
      for (const id of readVoiceVectorStates(db).keys()) deleteVoiceVectors(db, id)
      await this.reconcile()
    },

    /**
     * Prune vectors of memos that are gone, then embed memos with no vector or a
     * vector made another way or under an older input version. Old vectors keep
     * answering until replaced, so a version bump never empties the table.
     */
    async reconcile(signal?: AbortSignal): Promise<void> {
      if (signal?.aborted) return
      const db = getRawIndexDatabase()
      const items = readVoiceItems()
      const states = readVoiceVectorStates(db)

      const known = new Set(items.map((item) => item.id))
      for (const id of states.keys()) if (!known.has(id)) deleteVoiceVectors(db, id)

      if (!isAIEnabled() || !getVaultPath()) return

      for (const item of items) {
        if (signal?.aborted) return
        const plan = planVoiceEmbedding(item)
        if (plan === 'wait') continue
        const state = states.get(item.id)
        if (state?.source === plan.source && state.inputVersion === inputVersion(plan.source)) {
          continue
        }
        try {
          await embedItem(item, plan)
        } catch (error) {
          logger.warn('Failed to embed voice memo', { itemId: item.id, error })
        }
      }
    }
  }
}
