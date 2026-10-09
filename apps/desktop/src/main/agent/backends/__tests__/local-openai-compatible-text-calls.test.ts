import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentLocalProviderPreset } from '@memry/contracts/ipc-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LocalOpenAICompatibleBackend } from '../local-openai-compatible-backend'
import type { BackendEvent } from '../../cli/types'
import type { TurnWriteGrant } from '../../turn-grants'

const MODEL = 'test-model'
const FIXTURES = join(__dirname, 'fixtures', 'text-tool-calls')

const PRESETS: Array<{ preset: AgentLocalProviderPreset; fixture: string }> = [
  { preset: 'llama_cpp', fixture: 'llama_cpp.sse' },
  { preset: 'lm_studio', fixture: 'lm_studio.sse' },
  { preset: 'custom', fixture: 'custom.sse' },
  { preset: 'ollama', fixture: 'ollama.ndjson' }
]

const nativeProbeCall = {
  role: 'assistant',
  content: null,
  tool_calls: [
    {
      id: 'probe-1',
      type: 'function',
      function: { name: 'memry_probe_echo', arguments: '{"text":"ok"}' }
    }
  ]
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
}

function finalAnswer(ollama: boolean): Response {
  if (ollama) {
    const lines = [
      {
        model: MODEL,
        created_at: '2026-10-09T00:00:00Z',
        message: { role: 'assistant', content: 'You have no tags.' },
        done: false
      },
      {
        model: MODEL,
        created_at: '2026-10-09T00:00:00Z',
        message: { role: 'assistant', content: '' },
        done_reason: 'stop',
        done: true
      }
    ]
    return new Response(lines.map((line) => JSON.stringify(line)).join('\n') + '\n', {
      headers: { 'content-type': 'application/x-ndjson' }
    })
  }
  const chunk = {
    id: 'chatcmpl-final',
    object: 'chat.completion.chunk',
    created: 0,
    model: MODEL,
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', content: 'You have no tags.' },
        finish_reason: 'stop'
      }
    ]
  }
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' }
  })
}

function replayFetch(fixture: string): typeof fetch {
  const recorded = readFileSync(join(FIXTURES, fixture), 'utf8')
  const ollama = fixture.endsWith('.ndjson')
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith('/models')) return json({ data: [{ id: MODEL }] })
    const body = JSON.parse(String(init?.body)) as {
      stream?: boolean
      tools?: unknown[]
      messages: Array<{ role: string }>
    }
    const isChatStep = String(url).endsWith('/api/chat') || (body.stream && body.tools)
    if (!isChatStep) {
      if (body.stream) return finalAnswer(false)
      const afterTool = body.messages.some((message) => message.role === 'tool')
      return json({
        choices: [{ message: afterTool ? { role: 'assistant', content: 'ok' } : nativeProbeCall }]
      })
    }
    if (body.messages.some((message) => message.role === 'tool')) return finalAnswer(ollama)
    return new Response(recorded, {
      headers: { 'content-type': ollama ? 'application/x-ndjson' : 'text/event-stream' }
    })
  }) as unknown as typeof fetch
}

describe('LocalOpenAICompatibleBackend text-format tool calls after a native probe', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each(PRESETS)('runs the tool on $preset', async ({ preset, fixture }) => {
    vi.stubGlobal('fetch', replayFetch(fixture))
    const execute = vi.fn(async () => ({ ok: true as const, data: { tags: [] } }))
    const backend = new LocalOpenAICompatibleBackend({
      getSettings: async () => ({
        preset,
        baseUrl: 'http://127.0.0.1:8080/v1',
        model: MODEL,
        apiKeyConfigured: false,
        allowNonLoopback: false,
        thinking: 'default'
      }),
      getApiKey: async () => null,
      toolBridge: { execute } as never
    })
    const run = await backend.runTurn({
      conversationId: 'conversation-1',
      writeGrant: 'turn-grant-1' as TurnWriteGrant,
      windowId: 'window-1',
      prompt: 'User: list my tags',
      options: { backend: 'local_openai_compatible', model: MODEL, toolsEnabled: true }
    })
    const events: BackendEvent[] = []
    for await (const event of run.events) events.push(event)

    expect(await run.waitExit()).toBe(0)
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'vault_get_tags', args: {} })
    )
    const text = events.flatMap((event) => (event.kind === 'assistant_delta' ? [event.text] : []))
    expect(text.join('')).not.toContain('tool_call')
    expect(text.join('')).toContain('You have no tags.')
  })
})
