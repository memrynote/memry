import type { AgentBackendModelList, AgentCliBackendId } from '@memry/contracts/ipc-agent'

/**
 * Model picker contents for the CLI backends.
 *
 * Shared because both the live agent handlers and the lazy pre-runtime handlers
 * answer `LIST_BACKEND_MODELS`: the settings pane opens before the runtime
 * starts, and two copies of this list drifted apart as soon as a backend was
 * added. Every list keeps `supportsCustomModel`, so a model newer than the app
 * stays typeable.
 */
export const CLI_MODEL_OPTIONS: Record<AgentCliBackendId, AgentBackendModelList> = {
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
  },
  // Antigravity model ids carry their own reasoning tier, so this list doubles
  // as the effort picker. `agy models` is the live catalogue, but reading it
  // costs an authenticated network round trip every time the picker opens.
  antigravity_cli: {
    backend: 'antigravity_cli',
    supportsCustomModel: true,
    models: [
      { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
      { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
      { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' },
      { id: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro (Low)' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' }
    ]
  }
}
