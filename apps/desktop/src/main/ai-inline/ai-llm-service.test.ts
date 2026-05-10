import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createOpenAI: vi.fn((options: Record<string, unknown>) => (model: string) => ({
    provider: 'openai-compatible',
    model,
    options
  })),
  createAnthropic: vi.fn((options: Record<string, unknown>) => (model: string) => ({
    provider: 'anthropic',
    model,
    options
  })),
  loggerInfo: vi.fn()
}))

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: mocks.createOpenAI
}))

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: mocks.createAnthropic
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({ info: mocks.loggerInfo })
}))

import { createLanguageModel } from './ai-llm-service'

describe('createLanguageModel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates ollama models with the local OpenAI-compatible endpoint by default', () => {
    const model = createLanguageModel({
      provider: 'ollama',
      model: 'llama3.2',
      baseUrl: '',
      apiKey: ''
    })

    expect(model).toMatchObject({
      provider: 'openai-compatible',
      model: 'llama3.2',
      options: { baseURL: 'http://localhost:11434/v1', apiKey: 'ollama' }
    })
    expect(mocks.loggerInfo).toHaveBeenCalledWith('Creating ollama model: llama3.2')
  })

  it('creates OpenAI and Anthropic models only when API keys are present', () => {
    expect(() =>
      createLanguageModel({ provider: 'openai', model: 'gpt-5.4', baseUrl: '', apiKey: '' })
    ).toThrow('OpenAI API key required')
    expect(() =>
      createLanguageModel({ provider: 'anthropic', model: 'claude-4', baseUrl: '', apiKey: '' })
    ).toThrow('Anthropic API key required')

    expect(
      createLanguageModel({
        provider: 'openai',
        model: 'gpt-5.4',
        baseUrl: '',
        apiKey: 'openai-key'
      })
    ).toMatchObject({ model: 'gpt-5.4', options: { apiKey: 'openai-key' } })

    expect(
      createLanguageModel({
        provider: 'anthropic',
        model: 'claude-4',
        baseUrl: '',
        apiKey: 'anthropic-key'
      })
    ).toMatchObject({ provider: 'anthropic', model: 'claude-4' })
  })

  it('rejects unsupported providers', () => {
    expect(() =>
      createLanguageModel({
        provider: 'local' as never,
        model: 'other',
        baseUrl: '',
        apiKey: ''
      })
    ).toThrow('Unsupported provider: local')
  })
})
