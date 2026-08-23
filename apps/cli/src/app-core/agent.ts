import { spawnSync } from 'node:child_process'

import type {
  AgentBackendModelList,
  AgentBackendStatus,
  AgentCliBackendId,
  AgentLocalProviderPreset,
  AgentLocalProviderSettings,
  BackendStatusesResponse
} from '@memry/contracts/ipc-agent'

import type { SettingsService } from '@memry/app-core/settings'

export interface AgentLocalProviderSettingsUpdateInput {
  preset?: AgentLocalProviderPreset
  baseUrl?: string
  model?: string
  allowNonLoopback?: boolean
}

export interface AgentService {
  backendStatuses(): Promise<BackendStatusesResponse>
  backendModels(backend: AgentCliBackendId): Promise<AgentBackendModelList>
  getLocalProviderSettings(): Promise<AgentLocalProviderSettings>
  setLocalProviderSettings(
    input: AgentLocalProviderSettingsUpdateInput
  ): Promise<AgentLocalProviderSettings>
}

const AGENT_SETTING_KEY = 'agent'

const CLI_MODEL_OPTIONS: Record<AgentCliBackendId, AgentBackendModelList> = {
  claude_cli: {
    backend: 'claude_cli',
    supportsCustomModel: true,
    models: [
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'haiku', label: 'Haiku' },
      { id: 'opus', label: 'Opus' }
    ]
  },
  codex_cli: {
    backend: 'codex_cli',
    supportsCustomModel: true,
    models: [
      { id: 'gpt-5.5', label: 'GPT-5.5' },
      { id: 'gpt-5.4', label: 'GPT-5.4' },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' }
    ]
  }
}

const LOCAL_PROVIDER_PRESETS: Record<
  Exclude<AgentLocalProviderPreset, 'custom'>,
  { baseUrl: string; model: string }
> = {
  ollama: { baseUrl: 'http://localhost:11434/v1', model: '' },
  lm_studio: { baseUrl: 'http://localhost:1234/v1', model: '' },
  llama_cpp: { baseUrl: 'http://127.0.0.1:8080/v1', model: '' }
}

function defaultLocalProvider(preset: AgentLocalProviderPreset): {
  baseUrl: string
  model: string
} {
  return preset === 'custom' ? LOCAL_PROVIDER_PRESETS.ollama : LOCAL_PROVIDER_PRESETS[preset]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asPreset(value: unknown): AgentLocalProviderPreset | null {
  return value === 'ollama' || value === 'lm_studio' || value === 'llama_cpp' || value === 'custom'
    ? value
    : null
}

function firstOutputLine(stdout: string | Buffer | null, stderr: string | Buffer | null): string {
  return (
    `${stdout ?? ''}\n${stderr ?? ''}`
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  )
}

function probeCliBackend(
  command: 'claude' | 'codex',
  backend: AgentCliBackendId
): AgentBackendStatus {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    timeout: 2000
  })

  if (result.error) {
    const reason =
      (result.error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'probe_failed'
    return {
      backend,
      available: false,
      reason,
      detail: result.error.message
    }
  }

  const line = firstOutputLine(result.stdout, result.stderr)
  if (result.status !== 0) {
    return {
      backend,
      available: false,
      reason: 'probe_failed',
      detail: line || `Exited with status ${result.status ?? 'unknown'}`
    }
  }

  return {
    backend,
    available: true,
    reason: null,
    detail: null,
    version: line || null
  }
}

export function isLoopbackBaseUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

function getStoredLocalProvider(value: unknown): Partial<AgentLocalProviderSettings> {
  if (!isRecord(value) || !isRecord(value.localProvider)) return {}
  return value.localProvider
}

function getStoredAgent(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

export function createAgentService(settings: SettingsService): AgentService {
  async function readLocalProviderSettings(): Promise<AgentLocalProviderSettings> {
    const agentSetting = await settings.get(AGENT_SETTING_KEY)
    const local = getStoredLocalProvider(agentSetting?.value)
    const preset = asPreset(local.preset) ?? 'ollama'
    const defaults = defaultLocalProvider(preset)

    return {
      preset,
      baseUrl: typeof local.baseUrl === 'string' ? local.baseUrl : defaults.baseUrl,
      model: typeof local.model === 'string' ? local.model : defaults.model,
      apiKeyConfigured: false,
      allowNonLoopback: typeof local.allowNonLoopback === 'boolean' ? local.allowNonLoopback : false
    }
  }

  return {
    async backendStatuses() {
      const localProvider = await readLocalProviderSettings()
      return {
        claude_cli: probeCliBackend('claude', 'claude_cli'),
        codex_cli: probeCliBackend('codex', 'codex_cli'),
        local_openai_compatible: {
          backend: 'local_openai_compatible',
          available: false,
          reason: 'not_probed',
          detail: `Configured at ${localProvider.baseUrl}; use desktop Agent Chat to test live provider connectivity.`
        }
      }
    },

    async backendModels(backend) {
      const models = CLI_MODEL_OPTIONS[backend]
      if (!models) throw new Error(`Unsupported CLI agent backend: ${backend}`)
      return {
        ...models,
        models: models.models.map((model) => ({ ...model }))
      }
    },

    getLocalProviderSettings() {
      return readLocalProviderSettings()
    },

    async setLocalProviderSettings(input) {
      const current = await readLocalProviderSettings()
      const nextPreset = input.preset ?? current.preset
      const presetChanged = input.preset !== undefined && input.preset !== current.preset
      const defaults = defaultLocalProvider(nextPreset)
      const next = {
        preset: nextPreset,
        baseUrl: input.baseUrl ?? (presetChanged ? defaults.baseUrl : current.baseUrl),
        model: input.model ?? (presetChanged ? defaults.model : current.model),
        allowNonLoopback: input.allowNonLoopback ?? current.allowNonLoopback
      }

      if (!isLoopbackBaseUrl(next.baseUrl) && !next.allowNonLoopback) {
        throw new Error('Non-loopback local provider endpoints require explicit confirmation.')
      }

      const agentSetting = await settings.get(AGENT_SETTING_KEY)
      await settings.set(AGENT_SETTING_KEY, {
        ...getStoredAgent(agentSetting?.value),
        localProvider: next
      })

      return readLocalProviderSettings()
    }
  }
}
