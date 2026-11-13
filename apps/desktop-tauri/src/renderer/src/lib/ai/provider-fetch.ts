import { Channel, invoke } from '@tauri-apps/api/core'
import type { AiProvider, AiProviderHead, AiProviderRequest } from '../../../../generated/bindings'
import { commands } from '../../../../generated/bindings'
import { decodeChunk } from '@/lib/ipc-binary'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'

const log = createLogger('AI:ProviderFetch')

/** The origin every provider of the AI SDK is built with. Nothing resolves it: the fetch below
 * hands the path to Rust, which owns the real address and the key. */
export const PROXY_ORIGIN = 'http://ai-proxy.invalid'

/** The ceiling of the inline chat server it replaces (`ai-chat-server.ts:19`). */
export const MAX_BODY_BYTES = 25 * 1024 * 1024

/** The body frame tags of `memry_desktop::ai::proxy::Frame`. */
const FRAME_DATA = 0
const FRAME_END = 1
const FRAME_FAILED = 2

/** Statuses a `Response` must have no body for. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304])

export function proxyBaseUrl(provider: AiProvider): string {
  return `${PROXY_ORIGIN}/${provider}`
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

function cancel(requestId: string): void {
  commands.aiProviderCancel(requestId).catch((error: unknown) => {
    log.warn('Cancelling a provider request failed', error)
  })
}

/**
 * A `fetch` for the AI SDK's provider of `provider`: the request goes to `ai_provider_request`,
 * the provider's status and headers come back as the response, and its body streams in chunk by
 * chunk as Rust forwards them. Aborting the signal cancels the upstream request.
 */
export function createProviderFetch(provider: AiProvider): typeof fetch {
  const prefix = proxyBaseUrl(provider)
  return async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (`${url.origin}${url.pathname}`.indexOf(`${prefix}/`) !== 0) {
      throw new TypeError(`Not a ${provider} provider address`)
    }
    const signal = request.signal
    if (signal.aborted) throw abortError(signal)
    const method = request.method.toUpperCase()
    if (method !== 'GET' && method !== 'POST') {
      throw new TypeError(`Unsupported provider request method ${method}`)
    }
    const body = method === 'POST' ? await request.text() : null
    if (body !== null && new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
      throw new Error('Request body too large')
    }

    const requestId = crypto.randomUUID()
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null
    let finished = false
    const finish = (end: (stream: ReadableStreamDefaultController<Uint8Array>) => void): void => {
      if (finished || !controller) return
      finished = true
      signal.removeEventListener('abort', onAbort)
      end(controller)
    }
    const stream = new ReadableStream<Uint8Array>({
      start(start) {
        controller = start
      },
      cancel() {
        if (finished) return
        finished = true
        signal.removeEventListener('abort', onAbort)
        cancel(requestId)
      }
    })
    const decoder = new TextDecoder()
    const channel = new Channel<ArrayBuffer>((data) => {
      const frame = decodeChunk(data)
      switch (frame[0]) {
        case FRAME_DATA:
          if (!finished) controller?.enqueue(frame.subarray(1))
          break
        case FRAME_END:
          finish((target) => target.close())
          break
        case FRAME_FAILED:
          finish((target) => target.error(new Error(decoder.decode(frame.subarray(1)))))
          break
      }
    })
    function onAbort(): void {
      cancel(requestId)
      finish((target) => target.error(abortError(signal)))
    }
    signal.addEventListener('abort', onAbort)

    const proxied: AiProviderRequest = {
      requestId,
      provider,
      method,
      path: request.url.slice(prefix.length),
      headers: [...request.headers].map(([name, value]) => ({ name, value })),
      body
    }
    let head: AiProviderHead
    try {
      head = await invoke<AiProviderHead>('ai_provider_request', {
        request: proxied,
        onChunk: channel
      })
    } catch (error) {
      signal.removeEventListener('abort', onAbort)
      finished = true
      if (signal.aborted) throw abortError(signal)
      throw new Error(extractErrorMessage(error), { cause: error })
    }
    if (signal.aborted) throw abortError(signal)
    return new Response(NULL_BODY_STATUSES.has(head.status) ? null : stream, {
      status: head.status,
      headers: head.headers.map(({ name, value }): [string, string] => [name, value])
    })
  }
}
