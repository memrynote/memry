import { createLogger } from './lib/logger'

const configLog = createLogger('Config')

/**
 * Environment configuration for external services
 */
interface EnvironmentConfig {
  /** Optional environment OpenAI API key for development-only integrations */
  openaiApiKey: string | undefined
  /** Whisper model to use for transcription */
  whisperModel: string
  /** Embedding model to use for AI suggestions */
  embeddingModel: string
}

/**
 * Global environment configuration
 * Loaded once at startup, accessible throughout main process
 */
export const envConfig: EnvironmentConfig = {
  openaiApiKey: undefined,
  whisperModel: 'whisper-1',
  embeddingModel: 'text-embedding-3-small'
}

/**
 * Load and validate environment variables for external services
 */
export function loadEnvironmentConfig(): void {
  // Optional development OpenAI API key
  envConfig.openaiApiKey = process.env.OPENAI_API_KEY

  if (!envConfig.openaiApiKey) {
    configLog.debug('OPENAI_API_KEY not set. Voice transcription will rely on BYOK settings.')
  } else {
    configLog.info('OpenAI API key loaded successfully')
  }

  // Optional: Override default models
  if (process.env.OPENAI_WHISPER_MODEL) {
    envConfig.whisperModel = process.env.OPENAI_WHISPER_MODEL
  }

  if (process.env.OPENAI_EMBEDDING_MODEL) {
    envConfig.embeddingModel = process.env.OPENAI_EMBEDDING_MODEL
  }
}
