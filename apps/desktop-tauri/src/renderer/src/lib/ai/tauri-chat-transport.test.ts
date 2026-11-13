import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage, UIMessageChunk } from 'ai'
import type { AiProvider, InlineAiSettings } from '../../../../generated/bindings'
import { dataFrame, endFrame, fakeProviderIpc } from './fake-provider-ipc.test-helper'

const ipc = vi.hoisted(() => ({ current: null as ReturnType<typeof fakeProviderIpc> | null }))
vi.mock('@tauri-apps/api/core', async () => {
  const { FakeChannel } = await import('./fake-provider-ipc.test-helper')
  return {
    Channel: FakeChannel,
    invoke: (command: string, args: Record<string, unknown>) => ipc.current!.invoke(command, args)
  }
})
vi.mock('../../../../generated/bindings', () => ({
  commands: { aiProviderCancel: (id: string) => ipc.current!.cancel(id) }
}))

import { TauriChatTransport } from './tauri-chat-transport'

let fake: ReturnType<typeof fakeProviderIpc>
beforeEach(() => {
  fake = fakeProviderIpc()
  ipc.current = fake
})

const settings = (provider: AiProvider): InlineAiSettings => ({
  enabled: true,
  provider,
  model: 'm-1',
  apiKey: '\u2022'.repeat(8),
  baseUrl: ''
})

const messages: UIMessage[] = [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Summarize' }] }
]

const toolDefinitions = {
  applyDocumentOperations: {
    description: 'Apply operations to the document',
    inputSchema: {
      type: 'object',
      properties: { operations: { type: 'array', items: { type: 'object' } } },
      required: ['operations']
    },
    outputSchema: { type: 'object' }
  }
}

async function send(
  provider: AiProvider,
  abortSignal?: AbortSignal
): Promise<ReadableStream<UIMessageChunk>> {
  return new TauriChatTransport(() => Promise.resolve(settings(provider))).sendMessages({
    trigger: 'submit-message',
    chatId: 'c1',
    messageId: undefined,
    messages,
    abortSignal,
    body: { toolDefinitions }
  })
}

async function firstRequest(): Promise<{ path: string; body: Record<string, unknown> }> {
  await vi.waitFor(() => expect(fake.calls.length).toBeGreaterThan(0))
  const request = fake.calls[0].request
  return { path: request.path, body: JSON.parse(request.body ?? '{}') }
}

async function collect(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('TauriChatTransport', () => {
  it('forces a tool call except on Anthropic, which rejects a forced one', async () => {
    const cases: Array<[AiProvider, string, (body: Record<string, unknown>) => unknown, unknown]> =
      [
        ['openai', '/responses', (body) => body.tool_choice, 'required'],
        ['ollama', '/responses', (body) => body.tool_choice, 'required'],
        ['custom', '/chat/completions', (body) => body.tool_choice, 'required'],
        ['anthropic', '/messages', (body) => body.tool_choice, { type: 'auto' }],
        [
          'google',
          '/models/m-1:streamGenerateContent?alt=sse',
          (body) => body.toolConfig,
          { functionCallingConfig: { mode: 'ANY' } }
        ]
      ]
    for (const [provider, path, choice, expected] of cases) {
      fake = fakeProviderIpc()
      ipc.current = fake
      const abort = new AbortController()
      const stream = await send(provider, abort.signal)
      const reading = collect(stream).catch(() => [])
      const request = await firstRequest()
      expect(request.path, provider).toBe(path)
      expect(choice(request.body), provider).toEqual(expected)
      expect(JSON.stringify(request.body), provider).toContain('applyDocumentOperations')
      abort.abort()
      fake.calls[0].fail({ kind: 'invalid', code: 'ai.cancelled', message: 'cancelled' })
      await reading
    }
  })

  it('streams the provider answer into UI message chunks as it arrives', async () => {
    const stream = await send('custom')
    const reading = collect(stream)
    await firstRequest()
    const call = fake.calls[0]
    call.answer({ status: 200, headers: [{ name: 'content-type', value: 'text/event-stream' }] })
    const delta = (content: string): string =>
      `data: ${JSON.stringify({
        id: 'c',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'm-1',
        choices: [{ index: 0, delta: { content }, finish_reason: null }]
      })}\n\n`
    call.send(dataFrame(delta('Hel')))
    call.send(dataFrame(delta('lo')))
    call.send(
      dataFrame(
        `data: ${JSON.stringify({
          id: 'c',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'm-1',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
        })}\n\ndata: [DONE]\n\n`
      )
    )
    call.send(endFrame())
    const chunks = await reading
    const text = chunks
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => (chunk.type === 'text-delta' ? chunk.delta : ''))
      .join('')
    expect(text).toBe('Hello')
    expect(chunks.at(-1)?.type).toBe('finish')
  })

  it('puts a refused request into the stream as an error the menu shows', async () => {
    const stream = await send('anthropic')
    const reading = collect(stream)
    await firstRequest()
    fake.calls[0].fail({
      kind: 'invalid',
      code: 'ai.apiKeyMissing',
      message: 'Add your Anthropic API key in Settings → AI to use writing tools.'
    })
    const chunks = await reading
    const error = chunks.find((chunk) => chunk.type === 'error')
    expect(error && 'errorText' in error ? error.errorText : '').toContain(
      'Add your Anthropic API key'
    )
  })
})
