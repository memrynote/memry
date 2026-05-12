import type {
  AgentLocalProviderPreset,
  AgentLocalProviderSettings,
  AgentLocalProviderSettingsUpdate
} from '@memry/contracts/ipc-agent'

import { store } from '../../store'
import { hasLocalProviderApiKey, setLocalProviderApiKey } from './local-provider-keychain'

export const LOCAL_PROVIDER_PRESETS: Record<
  Exclude<AgentLocalProviderPreset, 'custom'>,
  { baseUrl: string; model: string }
> = {
  ollama: { baseUrl: 'http://localhost:11434/v1', model: '' },
  lm_studio: { baseUrl: 'http://localhost:1234/v1', model: '' },
  llama_cpp: { baseUrl: 'http://127.0.0.1:8080/v1', model: '' }
}

export async function getLocalProviderSettings(): Promise<AgentLocalProviderSettings> {
  const agent = store.get('agent')
  const local = agent.localProvider ?? {}
  const preset = local.preset ?? 'ollama'
  const defaults =
    preset === 'custom' ? LOCAL_PROVIDER_PRESETS.ollama : LOCAL_PROVIDER_PRESETS[preset]

  return {
    preset,
    baseUrl: local.baseUrl ?? defaults.baseUrl,
    model: local.model ?? defaults.model,
    allowNonLoopback: local.allowNonLoopback ?? false,
    apiKeyConfigured: await hasLocalProviderApiKey()
  }
}

export async function setLocalProviderSettings(
  input: AgentLocalProviderSettingsUpdate
): Promise<AgentLocalProviderSettings> {
  if (!isLoopbackBaseUrl(input.baseUrl) && !input.allowNonLoopback) {
    throw new Error('Non-loopback local provider endpoints require explicit confirmation.')
  }

  store.set('agent', {
    ...store.get('agent'),
    localProvider: {
      preset: input.preset,
      baseUrl: input.baseUrl,
      model: input.model,
      allowNonLoopback: input.allowNonLoopback
    }
  })

  if (input.clearApiKey || input.apiKey === null) {
    await setLocalProviderApiKey(null)
  } else if (input.apiKey !== undefined) {
    await setLocalProviderApiKey(input.apiKey)
  }

  return getLocalProviderSettings()
}

export function isLoopbackBaseUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}
