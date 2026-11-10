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
  createGoogleGenerativeAI: vi.fn((options: Record<string, unknown>) => (model: string) => ({
    provider: 'google',
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

vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: mocks.createGoogleGenerativeAI
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({ info: mocks.loggerInfo })
}))

import { generateText, Output } from 'ai'
import { z } from 'zod'

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

  it('creates Google models only when an API key is present', () => {
    expect(() =>
      createLanguageModel({
        provider: 'google',
        model: 'gemini-3.8-flash',
        baseUrl: '',
        apiKey: ''
      })
    ).toThrow('Google API key required')

    expect(
      createLanguageModel({
        provider: 'google',
        model: 'gemini-3.8-flash',
        baseUrl: '',
        apiKey: 'google-key'
      })
    ).toMatchObject({
      provider: 'google',
      model: 'gemini-3.8-flash',
      options: { apiKey: 'google-key' }
    })
  })

  it('sends custom provider requests to its OpenAI-compatible chat endpoint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            id: 'gen-1',
            created: 0,
            model: 'anthropic/claude-sonnet-4',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: '{"ok":true}' },
                finish_reason: 'stop'
              }
            ]
          }),
          { headers: { 'content-type': 'application/json' } }
        )
    )
    const settings = {
      enabled: true,
      provider: 'custom' as const,
      model: 'anthropic/claude-sonnet-4',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-key'
    }

    const { output } = await generateText({
      model: createLanguageModel(settings),
      prompt: 'hi',
      output: Output.object({ schema: z.object({ ok: z.boolean() }) })
    })
    await generateText({ model: createLanguageModel({ ...settings, apiKey: '' }), prompt: 'hi' })

    expect(output).toEqual({ ok: true })
    const [[url, keyed], [, keyless]] = fetchSpy.mock.calls
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(new Headers(keyed?.headers).get('authorization')).toBe('Bearer sk-or-key')
    expect(JSON.parse(typeof keyed?.body === 'string' ? keyed.body : '')).toMatchObject({
      model: 'anthropic/claude-sonnet-4',
      response_format: { type: 'json_schema' }
    })
    expect(new Headers(keyless?.headers).has('authorization')).toBe(false)
    fetchSpy.mockRestore()
  })

  it('requires a URL for the custom provider', () => {
    expect(() =>
      createLanguageModel({
        enabled: true,
        provider: 'custom',
        model: 'm',
        baseUrl: '',
        apiKey: ''
      })
    ).toThrow('Custom provider URL required')
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
