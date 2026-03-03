import { MockWebSocketPair, WebSocketRequestResponsePair } from './cloudflare-workers'
;(globalThis as Record<string, unknown>).WebSocketPair = MockWebSocketPair
;(globalThis as Record<string, unknown>).WebSocketRequestResponsePair = WebSocketRequestResponsePair

const OriginalResponse = globalThis.Response

class CFResponse extends OriginalResponse {
  override webSocket: WebSocket | null = null

  constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: WebSocket | null }) {
    const status = init?.status
    if (status === 101) {
      super(null, { ...init, status: 200 })
      Object.defineProperty(this, 'status', { value: 101 })
      this.webSocket = init?.webSocket ?? null
    } else {
      super(body, init)
    }
  }
}

;(globalThis as Record<string, unknown>).Response = CFResponse
