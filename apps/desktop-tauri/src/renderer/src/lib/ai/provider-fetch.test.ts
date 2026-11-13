import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiProviderHead, AiProviderRequest } from '../../../../generated/bindings'
import {
  fakeProviderIpc,
  type FakeCall,
  dataFrame,
  endFrame,
  failedFrame
} from './fake-provider-ipc.test-helper'

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

import { MAX_BODY_BYTES, createProviderFetch } from './provider-fetch'

const OK: AiProviderHead = {
  status: 200,
  headers: [{ name: 'content-type', value: 'text/event-stream' }]
}

let fake: ReturnType<typeof fakeProviderIpc>
beforeEach(() => {
  fake = fakeProviderIpc()
  ipc.current = fake
})

async function started(): Promise<FakeCall> {
  await vi.waitFor(() => expect(fake.calls).toHaveLength(1))
  return fake.calls[0]
}

const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes)

describe('createProviderFetch', () => {
  it('hands the path, headers and body to Rust and never names a host', async () => {
    const fetching = createProviderFetch('openai')(
      'http://ai-proxy.invalid/openai/chat/completions?x=1',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer placeholder' },
        body: '{"stream":true}'
      }
    )
    const call = await started()
    call.answer(OK)
    const response = await fetching
    const request: AiProviderRequest = call.request
    expect(request).toMatchObject({
      provider: 'openai',
      method: 'POST',
      path: '/chat/completions?x=1',
      body: '{"stream":true}'
    })
    expect(request.headers).toContainEqual({ name: 'content-type', value: 'application/json' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
  })

  it('streams each chunk as Rust forwards it and ends on the end frame', async () => {
    const fetching = createProviderFetch('custom')('http://ai-proxy.invalid/custom/chat', {
      method: 'POST',
      body: '{}'
    })
    const call = await started()
    call.answer(OK)
    const reader = (await fetching).body!.getReader()

    call.send(dataFrame('data: 1\n\n'))
    expect(text((await reader.read()).value)).toBe('data: 1\n\n')
    // The second chunk has not arrived yet; the first was readable without it.
    call.send(dataFrame('data: 2\n\n'))
    expect(text((await reader.read()).value)).toBe('data: 2\n\n')
    call.send(endFrame())
    expect((await reader.read()).done).toBe(true)
    expect(fake.cancelled).toEqual([])
  })

  it('errors the body with the message of a stream that broke off', async () => {
    const fetching = createProviderFetch('anthropic')(
      'http://ai-proxy.invalid/anthropic/messages',
      {
        method: 'POST',
        body: '{}'
      }
    )
    const call = await started()
    call.answer(OK)
    const reader = (await fetching).body!.getReader()
    call.send(failedFrame('Anthropic: the connection broke off'))
    await expect(reader.read()).rejects.toThrow('Anthropic: the connection broke off')
  })

  it('cancels the upstream request on abort before the head', async () => {
    const abort = new AbortController()
    const fetching = createProviderFetch('openai')('http://ai-proxy.invalid/openai/responses', {
      method: 'POST',
      body: '{}',
      signal: abort.signal
    })
    const call = await started()
    abort.abort()
    call.fail({ kind: 'invalid', code: 'ai.cancelled', message: 'the request was cancelled' })
    await expect(fetching).rejects.toMatchObject({ name: 'AbortError' })
    expect(fake.cancelled).toEqual([call.request.requestId])
  })

  it('cancels the upstream request on abort mid-stream and when the reader cancels', async () => {
    const abort = new AbortController()
    const midStream = createProviderFetch('google')(
      'http://ai-proxy.invalid/google/models/g:streamGenerateContent?alt=sse',
      { method: 'POST', body: '{}', signal: abort.signal }
    )
    const first = await started()
    first.answer(OK)
    const reader = (await midStream).body!.getReader()
    first.send(dataFrame('data: 1\n\n'))
    await reader.read()
    abort.abort()
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })
    expect(fake.cancelled).toEqual([first.request.requestId])
    expect(first.request.path).toBe('/models/g:streamGenerateContent?alt=sse')

    const readerCancel = createProviderFetch('ollama')('http://ai-proxy.invalid/ollama/responses', {
      method: 'POST',
      body: '{}'
    })
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2))
    const second = fake.calls[1]
    second.answer(OK)
    await (await readerCancel).body!.cancel()
    expect(fake.cancelled).toEqual([first.request.requestId, second.request.requestId])
  })

  it('refuses a body above 25 MiB before Rust sees it', async () => {
    const fetching = createProviderFetch('openai')('http://ai-proxy.invalid/openai/responses', {
      method: 'POST',
      body: 'x'.repeat(MAX_BODY_BYTES + 1)
    })
    await expect(fetching).rejects.toThrow('Request body too large')
    expect(fake.calls).toEqual([])
  })

  it('turns a refused command into an error with its message', async () => {
    const fetching = createProviderFetch('anthropic')(
      'http://ai-proxy.invalid/anthropic/messages',
      {
        method: 'POST',
        body: '{}'
      }
    )
    const call = await started()
    call.fail({
      kind: 'invalid',
      code: 'ai.apiKeyMissing',
      message: 'Add your Anthropic API key in Settings → AI to use writing tools.'
    })
    await expect(fetching).rejects.toThrow('Add your Anthropic API key')
  })

  it('answers a bodiless status without a body and refuses another address', async () => {
    const fetching = createProviderFetch('openai')('http://ai-proxy.invalid/openai/models')
    const call = await started()
    expect(call.request).toMatchObject({ method: 'GET', body: null })
    call.answer({ status: 204, headers: [] })
    expect((await fetching).body).toBeNull()

    await expect(
      createProviderFetch('openai')('http://ai-proxy.invalid/anthropic/messages')
    ).rejects.toThrow(TypeError)
    await expect(createProviderFetch('openai')('https://api.openai.com/v1/models')).rejects.toThrow(
      TypeError
    )
  })
})
