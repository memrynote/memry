import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import type { InlineAiSettings } from '../../../../generated/bindings'
import { createProviderFetch, proxyBaseUrl } from './provider-fetch'

/** Sent as the provider SDK's key. Rust drops every auth header the renderer sets and adds the
 * stored key, which never reaches the webview. */
const PLACEHOLDER_KEY = 'memry-ai-proxy'

/**
 * The AI SDK model of the inline AI settings (`createLanguageModel` of Electron's
 * `ai-llm-service.ts`), with every request going through `ai_provider_request`. Rust owns the
 * address, the key and the checks on both (a missing key fails the first request).
 */
export function createLanguageModel(
  settings: Pick<InlineAiSettings, 'provider' | 'model'>
): LanguageModel {
  const options = {
    baseURL: proxyBaseUrl(settings.provider),
    apiKey: PLACEHOLDER_KEY,
    fetch: createProviderFetch(settings.provider)
  }
  switch (settings.provider) {
    case 'ollama':
    case 'openai':
      return createOpenAI(options)(settings.model)
    case 'anthropic':
      return createAnthropic(options)(settings.model)
    case 'google':
      return createGoogleGenerativeAI(options)(settings.model)
    case 'custom':
      return createOpenAICompatible({
        ...options,
        name: 'custom',
        // Writing assist and field fill ask for JSON matching a schema. Without
        // this flag the request carries no schema and the model guesses the shape.
        supportsStructuredOutputs: true
      })(settings.model)
    default:
      throw new Error(`Unsupported provider: ${settings.provider satisfies never}`)
  }
}
