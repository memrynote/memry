import { beforeEach, describe, expect, it } from 'vitest'

import {
  persistAgentModelPreference,
  preferredConversationDefaults,
  readAgentModelPreference
} from './agent-model-preference'

describe('agent-model-preference', () => {
  beforeEach(() => localStorage.clear())

  it('returns null when nothing stored', () => {
    expect(readAgentModelPreference()).toBeNull()
  })

  it('round-trips a saved pick', () => {
    persistAgentModelPreference({
      provider: 'codex_cli',
      models: { codex_cli: 'gpt-5.5' },
      efforts: { claude_cli: 'low', codex_cli: 'high' },
      localModel: 'llama3'
    })
    expect(readAgentModelPreference()).toEqual({
      provider: 'codex_cli',
      models: { codex_cli: 'gpt-5.5' },
      efforts: { claude_cli: 'low', codex_cli: 'high' },
      localModel: 'llama3'
    })
  })

  it('tolerates the pre-effort persisted shape', () => {
    localStorage.setItem(
      'memry:agent-model-preference',
      JSON.stringify({ provider: 'claude_cli', models: { claude_cli: 'sonnet' } })
    )
    expect(readAgentModelPreference()).toEqual({
      provider: 'claude_cli',
      models: { claude_cli: 'sonnet' },
      efforts: {}
    })
  })

  it('rejects an unknown provider', () => {
    localStorage.setItem('memry:agent-model-preference', JSON.stringify({ provider: 'bogus' }))
    expect(readAgentModelPreference()).toBeNull()
  })

  it('seeds new-conversation defaults from the last pick', () => {
    expect(preferredConversationDefaults()).toBeUndefined()

    persistAgentModelPreference({ provider: 'local_openai_compatible', models: {} })
    expect(preferredConversationDefaults()).toEqual({ backend: 'local_openai_compatible' })

    persistAgentModelPreference({
      provider: 'local_openai_compatible',
      models: {},
      localModel: 'llama3'
    })
    expect(preferredConversationDefaults()).toEqual({
      backend: 'local_openai_compatible',
      backendModel: 'llama3'
    })

    persistAgentModelPreference({ provider: 'claude_cli', models: { claude_cli: 'sonnet' } })
    expect(preferredConversationDefaults()).toEqual({
      backend: 'claude_cli',
      backendModel: 'sonnet'
    })
  })

  it('ignores garbage, non-cli model keys, and invalid efforts', () => {
    localStorage.setItem('memry:agent-model-preference', 'not json')
    expect(readAgentModelPreference()).toBeNull()

    persistAgentModelPreference({
      provider: 'claude_cli',
      // @ts-expect-error exercising the runtime filter
      models: { claude_cli: 'opus', nope: 'x' },
      // @ts-expect-error exercising the runtime filter
      efforts: { claude_cli: 'ultrathink', codex_cli: 'xhigh' }
    })
    expect(readAgentModelPreference()).toEqual({
      provider: 'claude_cli',
      models: { claude_cli: 'opus' },
      efforts: { codex_cli: 'xhigh' }
    })
  })
})
