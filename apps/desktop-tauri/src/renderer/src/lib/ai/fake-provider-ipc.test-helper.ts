import type { AiProviderHead, AiProviderRequest } from '../../../../generated/bindings'

/** The `Channel` of `@tauri-apps/api/core` without a webview: the test calls `onmessage`. */
export class FakeChannel {
  constructor(readonly onmessage: (data: ArrayBuffer) => void) {}
}

/** One `ai_provider_request` call: answer its head (or fail it), then send body frames. */
export interface FakeCall {
  request: AiProviderRequest
  answer: (head: AiProviderHead) => void
  fail: (error: unknown) => void
  send: (frame: ArrayBuffer) => void
}

function frame(tag: number, payload = ''): ArrayBuffer {
  const bytes = new TextEncoder().encode(payload)
  const out = new Uint8Array(bytes.byteLength + 1)
  out[0] = tag
  out.set(bytes, 1)
  return out.buffer
}

export const dataFrame = (text: string): ArrayBuffer => frame(0, text)
export const endFrame = (): ArrayBuffer => frame(1)
export const failedFrame = (message: string): ArrayBuffer => frame(2, message)

/** Rust's side of the provider proxy, in memory. */
export function fakeProviderIpc(): {
  calls: FakeCall[]
  cancelled: string[]
  invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>
  cancel: (id: string) => Promise<null>
} {
  const calls: FakeCall[] = []
  const cancelled: string[] = []
  return {
    calls,
    cancelled,
    invoke: (command, args) => {
      if (command !== 'ai_provider_request') throw new Error(`unexpected command ${command}`)
      return new Promise((resolve, reject) => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the arguments provider-fetch.ts passes
        const { request, onChunk } = args as { request: AiProviderRequest; onChunk: FakeChannel }
        calls.push({
          request,
          answer: resolve,
          fail: reject,
          send: (data) => onChunk.onmessage(data)
        })
      })
    },
    cancel: (id) => {
      cancelled.push(id)
      return Promise.resolve(null)
    }
  }
}
