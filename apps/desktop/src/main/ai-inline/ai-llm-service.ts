import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { LanguageModel } from 'ai'

import type { AIInlineSettings } from '@memry/contracts/ai-inline-channels'
import { createLogger } from '../lib/logger'
import { markExpectedCondition } from '../telemetry/expected-conditions'

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
      if (!settings.apiKey) throw markExpectedCondition(new Error('OpenAI API key required'))
      return createOpenAI({ apiKey: settings.apiKey })(settings.model)

    case 'anthropic':
      if (!settings.apiKey) throw markExpectedCondition(new Error('Anthropic API key required'))
      return createAnthropic({ apiKey: settings.apiKey })(settings.model)

    case 'google':
      if (!settings.apiKey) throw markExpectedCondition(new Error('Google API key required'))
      return createGoogleGenerativeAI({ apiKey: settings.apiKey })(settings.model)

    case 'custom':
      if (!settings.baseUrl) throw markExpectedCondition(new Error('Custom provider URL required'))
      return createOpenAICompatible({
        name: 'custom',
        baseURL: settings.baseUrl,
        apiKey: settings.apiKey || undefined,
        // Writing assist and field fill ask for JSON matching a schema. Without
        // this flag the request carries no schema and the model guesses the shape.
        supportsStructuredOutputs: true
      })(settings.model)

    default:
      throw new Error(`Unsupported provider: ${settings.provider}`)
  }
}
