import type {
  AgentBackendModelList,
  AgentBackendModelOption,
  AgentCliBackendId
} from '@memry/contracts/ipc-agent'

import type { AgentProvider } from './agent-model-preference'

const DEFAULT_CLAUDE_MODEL = 'opus'

export const DEFAULT_SELECTED_MODELS: Record<AgentCliBackendId, string | null> = {
  claude_cli: DEFAULT_CLAUDE_MODEL,
  codex_cli: null,
  antigravity_cli: null
}

export const EMPTY_MODEL_OPTIONS: Record<AgentCliBackendId, AgentBackendModelList | null> = {
  claude_cli: null,
  codex_cli: null,
  antigravity_cli: null
}

export const MODEL_LABEL_FALLBACKS: Record<AgentCliBackendId, Record<string, string>> = {
  claude_cli: {
    sonnet: 'Sonnet',
    haiku: 'Haiku',
    opus: 'Opus'
  },
  codex_cli: {
    'gpt-5.5': 'GPT-5.5',
    'gpt-5.4': 'GPT-5.4',
    'gpt-5.4-mini': 'GPT-5.4 Mini'
  },
  antigravity_cli: {
    'gemini-3.8-flash-high': 'Gemini 3.8 Flash (High)',
    'gemini-3.8-flash-medium': 'Gemini 3.8 Flash (Medium)',
    'gemini-3.1-pro-high': 'Gemini 3.1 Pro (High)',
    'gemini-3.1-pro-low': 'Gemini 3.1 Pro (Low)',
    'claude-sonnet-4-6': 'Claude Sonnet 4.6 (Thinking)'
  }
}

export function isCliProvider(provider: AgentProvider): provider is AgentCliBackendId {
  return provider !== 'local_openai_compatible'
}

/** Loaded catalogue for a backend, falling back to the built-in labels. */
export function catalogFor(
  modelOptions: Record<AgentCliBackendId, AgentBackendModelList | null>,
  backend: AgentCliBackendId
): AgentBackendModelOption[] {
  const loaded = modelOptions[backend]?.models
  if (loaded?.length) return loaded
  return Object.entries(MODEL_LABEL_FALLBACKS[backend]).map(([id, label]) => ({ id, label }))
}

function codexModelVersion(modelId: string): number[] | null {
  const match = /^gpt[-_]?(\d+(?:[.-]\d+)*)(?:-.+)?$/i.exec(modelId)
  if (!match) return null
  return match[1].split(/[.-]/).map((segment) => Number(segment))
}

function compareCodexModels(left: string, right: string): number {
  const leftVersion = codexModelVersion(left)
  const rightVersion = codexModelVersion(right)
  if (!leftVersion && !rightVersion) return 0
  if (leftVersion && !rightVersion) return 1
  if (!leftVersion && rightVersion) return -1

  const maxLength = Math.max(leftVersion!.length, rightVersion!.length)
  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = leftVersion![index] ?? 0
    const rightPart = rightVersion![index] ?? 0
    if (leftPart !== rightPart) return leftPart - rightPart
  }
  return 0
}

function latestCodexModel(modelIds: string[]): string | null {
  return modelIds.reduce<string | null>((latest, modelId) => {
    if (!latest) return modelId
    return compareCodexModels(modelId, latest) > 0 ? modelId : latest
  }, null)
}

export function defaultModelForProvider(
  provider: AgentCliBackendId,
  modelOptions: AgentBackendModelList | null
): string | null {
  if (provider === 'claude_cli') return DEFAULT_CLAUDE_MODEL
  if (provider === 'antigravity_cli') {
    return (
      modelOptions?.models[0]?.id ?? Object.keys(MODEL_LABEL_FALLBACKS.antigravity_cli)[0] ?? null
    )
  }
  const codexModelIds =
    modelOptions?.models.length === 0 || !modelOptions
      ? Object.keys(MODEL_LABEL_FALLBACKS.codex_cli)
      : modelOptions.models.map((model) => model.id)
  return latestCodexModel(codexModelIds)
}
