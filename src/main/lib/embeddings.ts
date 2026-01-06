/**
 * Local Embedding Service
 *
 * Generates text embeddings locally using @huggingface/transformers
 * with the all-MiniLM-L6-v2 model (384 dimensions).
 *
 * Model is downloaded on first use (~23MB) and cached in app data directory.
 *
 * @module main/lib/embeddings
 */

import { app, BrowserWindow } from 'electron'
import path from 'path'
import { SettingsChannels } from '@shared/ipc-channels'

// ============================================================================
// Types
// ============================================================================

interface ModelProgress {
  status: string
  name?: string
  file?: string
  progress?: number
  loaded?: number
  total?: number
}

export interface ModelInfo {
  name: string
  dimension: number
  loaded: boolean
  loading: boolean
  error: string | null
}

// ============================================================================
// Constants
// ============================================================================

/** Model to use for embeddings */
const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2'

/** Embedding vector dimension */
export const EMBEDDING_DIMENSION = 384

/** Minimum content length to generate embedding */
const MIN_CONTENT_LENGTH = 10

/** Maximum characters for embedding input (~512 tokens) */
const MAX_CONTENT_LENGTH = 2000

// ============================================================================
// State
// ============================================================================

// Pipeline instance (lazy loaded)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let extractor: any = null
let isLoading = false
let loadError: string | null = null

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the cache directory for transformer models
 */
function getModelCacheDir(): string {
  return path.join(app.getPath('userData'), 'models', 'transformers')
}

/**
 * Emit model loading progress to all renderer windows
 */
function emitProgress(
  phase: 'downloading' | 'loading' | 'ready' | 'error',
  progress: number,
  status: string
): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(SettingsChannels.events.EMBEDDING_PROGRESS, {
      phase,
      progress,
      status
    })
  })
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Initialize the embedding model.
 * Downloads the model on first use (~23MB).
 * Should be called when vault opens for background loading.
 *
 * @returns true if model loaded successfully
 */
export async function initEmbeddingModel(): Promise<boolean> {
  // Already loaded
  if (extractor) {
    return true
  }

  // Already loading - wait for it
  if (isLoading) {
    console.log('[Embeddings] Model already loading, waiting...')
    while (isLoading) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return extractor !== null
  }

  isLoading = true
  loadError = null

  try {
    console.log('[Embeddings] Initializing embedding model...')
    emitProgress('loading', 0, 'Initializing embedding model...')

    // Dynamic import to avoid loading at startup
    const { pipeline, env } = await import('@huggingface/transformers')

    // Configure cache directory
    env.cacheDir = getModelCacheDir()
    console.log('[Embeddings] Cache directory:', env.cacheDir)

    emitProgress('downloading', 5, 'Loading model (downloading if first time)...')

    // Create feature extraction pipeline with progress callback
    // Explicitly set dtype to fp32 for CPU (silences "dtype not specified" warning)
    extractor = await pipeline('feature-extraction', MODEL_NAME, {
      dtype: 'fp32',
      progress_callback: (progress: ModelProgress) => {
        if (progress.status === 'progress' && progress.progress !== undefined) {
          const pct = Math.round(progress.progress)
          emitProgress('downloading', pct, `Downloading model: ${pct}%`)
        } else if (progress.status === 'done') {
          emitProgress('loading', 95, 'Finalizing model...')
        }
      }
    })

    emitProgress('ready', 100, 'Model ready')
    console.log('[Embeddings] Model loaded successfully')
    return true
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error)
    console.error('[Embeddings] Failed to load model:', loadError)
    emitProgress('error', 0, `Error: ${loadError}`)
    extractor = null
    return false
  } finally {
    isLoading = false
  }
}

/**
 * Generate embedding for text using local model.
 *
 * @param text - Text to generate embedding for
 * @returns Float32Array embedding or null on error
 */
export async function generateEmbedding(text: string): Promise<Float32Array | null> {
  // Validate input
  if (!text || text.trim().length < MIN_CONTENT_LENGTH) {
    return null
  }

  // Ensure model is loaded
  if (!extractor) {
    const loaded = await initEmbeddingModel()
    if (!loaded) {
      console.log('[Embeddings] Model not available, skipping embedding')
      return null
    }
  }

  try {
    // Truncate very long texts (model max ~512 tokens)
    const truncated = text.substring(0, MAX_CONTENT_LENGTH)

    // Generate embedding with mean pooling and normalization
    const output = await extractor(truncated, {
      pooling: 'mean',
      normalize: true
    })

    // Extract data as Float32Array
    const embedding = new Float32Array(output.data)

    // Verify dimension
    if (embedding.length !== EMBEDDING_DIMENSION) {
      console.error(
        `[Embeddings] Unexpected dimension: ${embedding.length} (expected ${EMBEDDING_DIMENSION})`
      )
      return null
    }

    return embedding
  } catch (error) {
    console.error('[Embeddings] Generation failed:', error)
    return null
  }
}

/**
 * Check if the embedding model is loaded
 */
export function isModelLoaded(): boolean {
  return extractor !== null
}

/**
 * Check if the model is currently loading
 */
export function isModelLoading(): boolean {
  return isLoading
}

/**
 * Get model information
 */
export function getModelInfo(): ModelInfo {
  return {
    name: 'all-MiniLM-L6-v2',
    dimension: EMBEDDING_DIMENSION,
    loaded: extractor !== null,
    loading: isLoading,
    error: loadError
  }
}

/**
 * Unload the model to free memory
 */
export function unloadModel(): void {
  extractor = null
  loadError = null
  console.log('[Embeddings] Model unloaded')
}
