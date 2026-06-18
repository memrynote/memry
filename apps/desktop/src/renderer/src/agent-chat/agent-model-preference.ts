import { createLogger } from '@/lib/logger'
import type { AgentBackendId, AgentCliBackendId } from '@memry/contracts/ipc-agent'

const log = createLogger('AgentModelPreference')
const STORAGE_KEY = 'memry:agent-model-preference'

export type AgentProvider = 'claude_cli' | 'codex_cli' | 'local_openai_compatible'

export interface AgentModelPreference {
  provider: AgentProvider
  models: Partial<Record<AgentCliBackendId, string | null>>
}

const PROVIDERS: AgentProvider[] = ['claude_cli', 'codex_cli', 'local_openai_compatible']
const CLI_BACKENDS: AgentCliBackendId[] = ['claude_cli', 'codex_cli']

/** Last provider + per-backend model the user picked. Device-local by design (no sync). */
export function readAgentModelPreference(): AgentModelPreference | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<AgentModelPreference>
    if (!parsed || !PROVIDERS.includes(parsed.provider as AgentProvider)) return null
    const models: Partial<Record<AgentCliBackendId, string | null>> = {}
    if (parsed.models && typeof parsed.models === 'object') {
      for (const backend of CLI_BACKENDS) {
        const value = parsed.models[backend]
        if (typeof value === 'string' || value === null) models[backend] = value
      }
    }
    return { provider: parsed.provider as AgentProvider, models }
  } catch (error) {
    log.warn('Failed to read agent model preference', error)
    return null
  }
}

export function persistAgentModelPreference(preference: AgentModelPreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preference))
  } catch (error) {
    log.warn('Failed to persist agent model preference', error)
  }
}

/** Backend + model to seed a new conversation with, from the last pick. Undefined = app default. */
export function preferredConversationDefaults():
  | { backend: AgentBackendId; backendModel?: string | null }
  | undefined {
  const pref = readAgentModelPreference()
  if (!pref) return undefined
  if (pref.provider === 'claude_cli' || pref.provider === 'codex_cli') {
    return { backend: pref.provider, backendModel: pref.models[pref.provider] ?? null }
  }
  return { backend: pref.provider }
}
