import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentLocalThinking, LocalReasoningEffort } from '@memry/contracts/ipc-agent'

import { LocalOpenAICompatibleBackend } from '../local-openai-compatible-backend'
import type { BackendEvent } from '../../cli/types'
import type { TurnWriteGrant } from '../../turn-grants'
import {
  type ChatRequest,
  DEEPSEEK_MODEL,
  DEEPSEEK_REASONING,
  DEEPSEEK_REPLY,
  type FakeDeepSeek,
  type FakeDeepSeekOptions,
  startFakeDeepSeek
} from './fixtures/deepseek-fake-server'

// DeepSeek's tool-call markup, as a model writes it when it was sent no tool schemas.
const DSML_REPLY =
  'I will list your tags.\n<\uff5c\uff5cDSML\uff5c\uff5c invoke name="vault_get_tags">'

let server: FakeDeepSeek | null = null

afterEach(async () => {
  await server?.close()
  server = null
})

async function runDeepSeekTurn(input: {
  server?: FakeDeepSeekOptions
  toolsEnabled?: boolean
  thinking?: AgentLocalThinking
  reasoningEffort?: LocalReasoningEffort
}): Promise<{
  events: BackendEvent[]
  exitCode: number
  stderr: string
  execute: ReturnType<typeof vi.fn>
  turnRequests: Array<{ body: ChatRequest; status: number }>
}> {
  server = await startFakeDeepSeek({ apiKey: 'sk-test', ...input.server })
  const execute = vi.fn(async () => ({ ok: true as const, data: { tags: [] } }))
  const backend = new LocalOpenAICompatibleBackend({
    getSettings: async () => ({
      preset: 'custom',
      baseUrl: server!.baseUrl,
      model: DEEPSEEK_MODEL,
      apiKeyConfigured: true,
      allowNonLoopback: true,
      thinking: input.thinking ?? 'default'
    }),
    getApiKey: async () => 'sk-test',
    toolBridge: { execute } as never
  })
  const run = await backend.runTurn({
    conversationId: 'conversation-1',
    writeGrant: 'turn-grant-1' as TurnWriteGrant,
    windowId: 'window-1',
    prompt: 'User: list my tags',
    options: {
      backend: 'local_openai_compatible',
      model: DEEPSEEK_MODEL,
      toolsEnabled: input.toolsEnabled ?? true,
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {})
    }
  })
  const events: BackendEvent[] = []
  for await (const event of run.events) events.push(event)
  let stderr = ''
  for await (const piece of run.stderr ?? []) stderr += piece.toString()
  return {
    events,
    exitCode: await run.waitExit(),
    stderr,
    execute,
    // The probe's requests carry its own prompt; the turn's carry the user's.
    turnRequests: server.requests.filter((request) =>
      JSON.stringify(request.body.messages).includes('list my tags')
    )
  }
}

function reasoningText(events: BackendEvent[]): string {
  return events.map((event) => (event.kind === 'reasoning_delta' ? event.text : '')).join('')
}

function assistantText(events: BackendEvent[]): string {
  return events.map((event) => (event.kind === 'assistant_delta' ? event.text : '')).join('')
}

describe('LocalOpenAICompatibleBackend against a DeepSeek-style provider', () => {
  it('falls back to no tool_choice when a named one is answered with HTTP 400 in thinking mode', async () => {
    const turn = await runDeepSeekTurn({})

    const named = server!.requests.filter((request) => typeof request.body.tool_choice === 'object')
    expect(named.map((request) => request.status)).toEqual([400])
    expect(turn.turnRequests.every((request) => request.body.tool_choice === undefined)).toBe(true)
    expect(turn.turnRequests.every((request) => request.status === 200)).toBe(true)
    expect(turn.exitCode).toBe(0)
    expect(turn.execute).toHaveBeenCalledTimes(1)
  })

  it('streams reasoning_content to the reasoning area and sends it back on later steps', async () => {
    const turn = await runDeepSeekTurn({})

    expect(turn.stderr).toBe('')
    expect(turn.exitCode).toBe(0)
    expect(turn.execute).toHaveBeenCalledWith({
      writeGrant: 'turn-grant-1',
      windowId: 'window-1',
      name: 'vault_get_tags',
      args: {}
    })
    expect(reasoningText(turn.events)).toBe(DEEPSEEK_REASONING + DEEPSEEK_REASONING)
    expect(turn.events.filter((event) => event.kind !== 'reasoning_delta')).toEqual([
      { kind: 'tool_use', toolUseId: 'call_1', name: 'vault_get_tags', args: {} },
      {
        kind: 'tool_result',
        toolUseId: 'call_1',
        ok: true,
        data: { ok: true, data: { tags: [] } }
      },
      { kind: 'assistant_delta', text: DEEPSEEK_REPLY },
      { kind: 'message_stop' }
    ])
    const continuation = turn.turnRequests.at(-1)?.body
    expect(continuation?.messages.find((message) => message.role === 'assistant')).toMatchObject({
      reasoning_content: DEEPSEEK_REASONING
    })
  })

  it('flags a tools-off turn and passes DSML markup through as text without running a tool', async () => {
    const turn = await runDeepSeekTurn({ server: { tools: 'reject', reply: DSML_REPLY } })

    expect(turn.exitCode).toBe(0)
    expect(turn.events[0]).toMatchObject({ kind: 'tools_unavailable', reason: 'tools_rejected' })
    expect(assistantText(turn.events)).toBe(DSML_REPLY)
    expect(turn.events.some((event) => event.kind === 'tool_use')).toBe(false)
    expect(turn.execute).not.toHaveBeenCalled()
    expect(turn.turnRequests.map((request) => request.body.tools)).toEqual([undefined])
  })

  it.each(['high', 'max'] as const)(
    'sends reasoning depth %s on the wire and the API accepts it',
    async (reasoningEffort) => {
      const turn = await runDeepSeekTurn({ toolsEnabled: false, reasoningEffort })

      expect(turn.turnRequests).toEqual([
        { body: expect.objectContaining({ reasoning_effort: reasoningEffort }), status: 200 }
      ])
      expect(turn.exitCode).toBe(0)
      expect(assistantText(turn.events)).toBe(DEEPSEEK_REPLY)
    }
  )

  it('sends thinking disabled for Thinking Off, and the reply carries no reasoning', async () => {
    const turn = await runDeepSeekTurn({ toolsEnabled: false, thinking: 'off' })

    expect(turn.turnRequests).toEqual([
      { body: expect.objectContaining({ thinking: { type: 'disabled' } }), status: 200 }
    ])
    expect(turn.turnRequests[0].body).not.toHaveProperty('reasoning_effort')
    expect(turn.exitCode).toBe(0)
    expect(reasoningText(turn.events)).toBe('')
    expect(assistantText(turn.events)).toBe(DEEPSEEK_REPLY)
  })

  it('stops a tool loop at the step limit with reasoning kept and a tool-free handoff', async () => {
    const turn = await runDeepSeekTurn({ server: { tools: 'always' } })

    expect(turn.exitCode).toBe(0)
    expect(turn.turnRequests).toHaveLength(24)
    expect(turn.turnRequests.every((request) => request.status === 200)).toBe(true)
    expect(turn.execute).toHaveBeenCalledTimes(23)
    const handoff = turn.turnRequests[23].body
    expect(handoff.tools).toBeUndefined()
    expect(JSON.stringify(handoff.messages)).toMatch(/what is done, what is left/)
    expect(
      handoff.messages.filter((message) => message.role === 'assistant' && message.tool_calls)
    ).toHaveLength(23)
    expect(turn.events.map((event) => event.kind).slice(-2)).toEqual(['step_limit', 'message_stop'])
  })
})
