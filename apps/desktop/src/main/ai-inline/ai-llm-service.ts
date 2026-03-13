import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import type { LanguageModel } from 'ai'

import type { AIInlineSettings } from '@memry/contracts/ai-inline-channels'
import { createLogger } from '../lib/logger'

const logger = createLogger('AI:LLM')

export function createLanguageModel(settings: AIInlineSettings): LanguageModel {
  logger.info(`Creating ${settings.provider} model: ${settings.model}`)

  switch (settings.provider) {
    case 'ollama':
      return createOpenAI({
        baseURL: settings.baseUrl || 'http://localhost:11434/v1',
        apiKey: 'ollama'
      })(settings.model)

    case 'openai':
      if (!settings.apiKey) throw new Error('OpenAI API key required')
      return createOpenAI({ apiKey: settings.apiKey })(settings.model)

    case 'anthropic':
      if (!settings.apiKey) throw new Error('Anthropic API key required')
      return createAnthropic({ apiKey: settings.apiKey })(settings.model)

    default:
      throw new Error(`Unsupported provider: ${(settings as AIInlineSettings).provider}`)
  }
}
