import { createLogger } from '@/lib/logger'
import type {
  AgentBackendId,
  AgentCliBackendId,
  ClaudeEffort,
  CodexReasoningEffort
} from '@memry/contracts/ipc-agent'

const log = createLogger('AgentModelPreference')
const STORAGE_KEY = 'memry:agent-model-preference'

export type AgentProvider = 'claude_cli' | 'codex_cli' | 'local_openai_compatible'

export interface AgentModelPreference {
  provider: AgentProvider
  models: Partial<Record<AgentCliBackendId, string | null>>
  efforts?: {
    claude_cli?: ClaudeEffort
    codex_cli?: CodexReasoningEffort
  }
  localModel?: string | null
}

const PROVIDERS: AgentProvider[] = ['claude_cli', 'codex_cli', 'local_openai_compatible']
const CLI_BACKENDS: AgentCliBackendId[] = ['claude_cli', 'codex_cli']
const CLAUDE_EFFORTS: ClaudeEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const CODEX_EFFORTS: CodexReasoningEffort[] = ['low', 'medium', 'high', 'xhigh']

/** Last provider + per-backend model/effort the user picked. Device-local by design (no sync). */
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
    // Older persisted shapes carry no efforts/localModel; treat them as unset.
    const efforts: AgentModelPreference['efforts'] = {}
    if (parsed.efforts && typeof parsed.efforts === 'object') {
      if (CLAUDE_EFFORTS.includes(parsed.efforts.claude_cli as ClaudeEffort)) {
        efforts.claude_cli = parsed.efforts.claude_cli
      }
      if (CODEX_EFFORTS.includes(parsed.efforts.codex_cli as CodexReasoningEffort)) {
        efforts.codex_cli = parsed.efforts.codex_cli
      }
    }
    const localModel =
      typeof parsed.localModel === 'string' || parsed.localModel === null
        ? parsed.localModel
        : undefined
    return {
      provider: parsed.provider as AgentProvider,
      models,
      efforts,
      ...(localModel !== undefined ? { localModel } : {})
    }
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
  { backend: AgentBackendId; backendModel?: string | null } | undefined {
  const pref = readAgentModelPreference()
  if (!pref) return undefined
  if (pref.provider === 'claude_cli' || pref.provider === 'codex_cli') {
    return { backend: pref.provider, backendModel: pref.models[pref.provider] ?? null }
  }
  return { backend: pref.provider, ...(pref.localModel ? { backendModel: pref.localModel } : {}) }
}
