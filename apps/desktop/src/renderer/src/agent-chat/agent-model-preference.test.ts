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
    persistAgentModelPreference({ provider: 'codex_cli', models: { codex_cli: 'gpt-5.5' } })
    expect(readAgentModelPreference()).toEqual({
      provider: 'codex_cli',
      models: { codex_cli: 'gpt-5.5' }
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

    persistAgentModelPreference({ provider: 'claude_cli', models: { claude_cli: 'sonnet' } })
    expect(preferredConversationDefaults()).toEqual({
      backend: 'claude_cli',
      backendModel: 'sonnet'
    })
  })

  it('ignores garbage and non-cli model keys', () => {
    localStorage.setItem('memry:agent-model-preference', 'not json')
    expect(readAgentModelPreference()).toBeNull()

    persistAgentModelPreference({
      provider: 'claude_cli',
      // @ts-expect-error exercising the runtime filter
      models: { claude_cli: 'opus', nope: 'x' }
    })
    expect(readAgentModelPreference()).toEqual({
      provider: 'claude_cli',
      models: { claude_cli: 'opus' }
    })
  })
})
