import { FoldAgentChoiceSchema, type FoldAgentChoice } from '@memry/contracts/note-fold'
import { SettingsChannels } from '@memry/contracts/ipc-channels'
import { SafeDimensionValueSchema } from '@memry/contracts/telemetry-api'
import { getDatabase } from '../database'
import {
  getModelInfo,
  initEmbeddingModel,
  isModelLoaded,
  isModelLoading,
  resetEmbeddingModelFailure,
  stopEmbeddingModel
} from '../lib/embeddings'
import { IMAGE_EMBEDDING_SETTING_KEY } from '../lib/image-embedding'
import { createLogger } from '../lib/logger'
import { getMainI18n } from '../lib/main-i18n'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { refreshNoteFold } from '../note-fold'
import { rebuildProjections, reconcileProjections } from '../projections'
import { trackMainEvent } from '../telemetry/track'
import { getSetting, setSetting } from './settings-store'

const logger = createLogger('AISettings')
const AI_ENABLED = 'ai.enabled'
const AI_SUMMARIZE_LONG_NOTES = 'ai.summarizeLongNotes'
const AI_SUMMARIZE_AGENT = 'ai.summarizeAgent'

export interface AISettings {
  enabled: boolean
  imageEmbeddings: boolean
  summarizeLongNotes: boolean
  summarizeAgent: FoldAgentChoice
}

export type AIModelStatus = ReturnType<typeof getModelInfo> & { embeddingCount: number }

const DEFAULT_AI_SETTINGS: AISettings = {
  enabled: true,
  imageEmbeddings: true,
  summarizeLongNotes: false,
  summarizeAgent: 'auto'
}

function getDbOrNull() {
  try {
    return getDatabase()
  } catch {
    return null
  }
}

export function getAISettings(): AISettings {
  const db = getDbOrNull()
  if (!db) return { ...DEFAULT_AI_SETTINGS }
  const agent = FoldAgentChoiceSchema.safeParse(getSetting(db, AI_SUMMARIZE_AGENT))
  return {
    enabled: getSetting(db, AI_ENABLED) !== 'false',
    imageEmbeddings: getSetting(db, IMAGE_EMBEDDING_SETTING_KEY) !== 'false',
    summarizeLongNotes: getSetting(db, AI_SUMMARIZE_LONG_NOTES) === 'true',
    // Unknown choices from another build must remain readable.
    summarizeAgent: agent.success ? agent.data : 'auto'
  }
}

export function writeAISettings(settings: Partial<AISettings>): {
  success: boolean
  error?: string
} {
  const db = getDbOrNull()
  if (!db) return { success: false, error: getMainI18n().t('errors:ipc.noVaultOpen') }
  const wasEnabled = getSetting(db, AI_ENABLED) !== 'false'

  if (settings.enabled !== undefined) {
    setSetting(db, AI_ENABLED, settings.enabled ? 'true' : 'false')
    if (settings.enabled) resetEmbeddingModelFailure()
  }
  if (settings.imageEmbeddings !== undefined) {
    setSetting(db, IMAGE_EMBEDDING_SETTING_KEY, settings.imageEmbeddings ? 'true' : 'false')
  }
  if (settings.summarizeLongNotes !== undefined) {
    setSetting(db, AI_SUMMARIZE_LONG_NOTES, settings.summarizeLongNotes ? 'true' : 'false')
  }
  if (settings.summarizeAgent !== undefined) {
    setSetting(db, AI_SUMMARIZE_AGENT, FoldAgentChoiceSchema.parse(settings.summarizeAgent))
  }

  if (
    settings.enabled !== undefined ||
    settings.summarizeLongNotes !== undefined ||
    settings.summarizeAgent !== undefined
  ) {
    refreshNoteFold()
  }
  broadcastToAllWindows(SettingsChannels.events.CHANGED, { key: 'ai', value: settings })
  for (const field of Object.keys(settings)) {
    const setting = `ai.${field}`
    if (SafeDimensionValueSchema.safeParse(setting).success) {
      trackMainEvent('setting_changed', {
        surface: 'settings',
        action: 'changed',
        dimensions: { setting }
      })
    }
  }

  if (settings.enabled === true && !wasEnabled) {
    // Invoke the existing facade synchronously: it captures this vault's runtime
    // before IPC can yield to a vault switch. That runtime owns serialization
    // and cancellation; indexing never delays the saved-setting acknowledgement.
    void reconcileProjections(['embedding', 'image-embedding', 'voice-embedding']).catch(
      (error: unknown) => {
        logger.error('AI embedding recovery failed', { error })
      }
    )
  } else if (settings.enabled === false && wasEnabled) {
    // Stop the worker too: a hung current inference cannot reach a per-chunk
    // setting check. The public bridge operation bounds shutdown to 3 seconds.
    void stopEmbeddingModel().catch((error: unknown) => {
      logger.error('AI embedding shutdown failed', { error })
    })
  }
  return { success: true }
}

export async function getAIModelStatus(): Promise<AIModelStatus> {
  const modelInfo = getModelInfo()
  let embeddingCount = 0
  try {
    // Suggestions loads its feature dependencies only when status is requested.
    const { getEmbeddingCount } = await import('../inbox/suggestions')
    embeddingCount = getEmbeddingCount()
  } catch (error) {
    logger.debug('Embedding count unavailable; the vault may be closed', { error })
  }
  return { ...modelInfo, embeddingCount }
}

export async function loadAIModel(): Promise<{
  success: boolean
  message?: string
  error?: string
}> {
  if (isModelLoaded()) return { success: true, message: 'Model already loaded' }
  if (isModelLoading()) {
    return { success: false, error: getMainI18n().t('errors:settings.modelAlreadyLoading') }
  }
  resetEmbeddingModelFailure()
  const success = await initEmbeddingModel()
  if (success) return { success: true }
  const info = getModelInfo()
  return {
    success: false,
    error: info.error || getMainI18n().t('errors:settings.modelLoadFailed')
  }
}

export async function reindexEmbeddings(): Promise<{
  success: boolean
  computed: number
  skipped: number
  error?: string
}> {
  resetEmbeddingModelFailure()
  const result = await rebuildProjections(['embedding'])
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the selected projector owns this rebuild result
  return result.embedding as {
    success: boolean
    computed: number
    skipped: number
    error?: string
  }
}
