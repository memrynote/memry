import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  AgentBackendOptions,
  AgentLocalProviderSettings,
  AgentLocalThinking,
  LocalReasoningEffort
} from '@memry/contracts/ipc-agent'

import type { TurnWriteGrant } from '../../turn-grants'
import { LocalOpenAICompatibleBackend } from '../local-openai-compatible-backend'

function settings(thinking: AgentLocalThinking): AgentLocalProviderSettings {
  return {
    preset: 'custom',
    baseUrl: 'https://deepseek.test/v1',
    model: 'deepseek-v4-flash',
    apiKeyConfigured: true,
    allowNonLoopback: true,
    thinking
  }
}

async function recordedBody(input: {
  thinking: AgentLocalThinking
  reasoningEffort?: LocalReasoningEffort
}): Promise<Record<string, unknown>> {
  const bodies: Record<string, unknown>[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      const chunk = {
        id: 'c',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'deepseek-v4-flash',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
      }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' }
      })
    })
  )
  const backend = new LocalOpenAICompatibleBackend({
    getSettings: async () => settings(input.thinking),
    getApiKey: async () => 'sk-test',
    toolBridge: { execute: vi.fn() } as never
  })
  const options: AgentBackendOptions = {
    backend: 'local_openai_compatible',
    toolsEnabled: false,
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {})
  }
  const run = await backend.runTurn({
    conversationId: 'conversation-1',
    writeGrant: 'turn-grant-1' as TurnWriteGrant,
    windowId: 'window-1',
    prompt: 'User: hi',
    options
  })
  for await (const event of run.events) void event
  expect(await run.waitExit()).toBe(0)
  expect(bodies).toHaveLength(1)
  return bodies[0]
}

describe('LocalOpenAICompatibleBackend reasoning settings', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    ['high', 'high'],
    ['max', 'max']
  ] as const)('depth %s sends reasoning_effort %s', async (reasoningEffort, expected) => {
    const body = await recordedBody({ thinking: 'default', reasoningEffort })
    expect(body.reasoning_effort).toBe(expected)
  })

  it('depth Default sends no reasoning_effort', async () => {
    const body = await recordedBody({ thinking: 'default', reasoningEffort: 'default' })
    expect(body).not.toHaveProperty('reasoning_effort')
    expect(await recordedBody({ thinking: 'default' })).not.toHaveProperty('reasoning_effort')
  })

  it('thinking Off sends thinking disabled', async () => {
    const body = await recordedBody({ thinking: 'off' })
    expect(body.thinking).toEqual({ type: 'disabled' })
  })

  it('thinking Default sends no thinking field', async () => {
    expect(await recordedBody({ thinking: 'default' })).not.toHaveProperty('thinking')
  })
})
