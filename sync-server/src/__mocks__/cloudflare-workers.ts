export class WebSocketRequestResponsePair {
  readonly request: string
  readonly response: string

  constructor(request: string, response: string) {
    this.request = request
    this.response = response
  }
}

export class MockWebSocket {
  readonly url: string | null = null
  readonly readyState = 1
  readonly extensions = ''
  readonly protocol = ''

  private _attachment: unknown = null
  private _tags: string[] = []
  private _closeCalled = false
  private _closeCode?: number
  private _closeReason?: string
  private _sentMessages: string[] = []

  constructor(tags?: string[]) {
    if (tags) this._tags = tags
  }

  accept(): void {
    // CF Workers WebSocket.accept() - no-op in mock
  }

  send(message: string): void {
    this._sentMessages.push(message)
  }

  close(code?: number, reason?: string): void {
    this._closeCalled = true
    this._closeCode = code
    this._closeReason = reason
  }

  serializeAttachment(attachment: unknown): void {
    this._attachment = attachment
  }

  deserializeAttachment(): unknown {
    return this._attachment
  }

  getTags(): string[] {
    return this._tags
  }

  get sentMessages(): string[] {
    return this._sentMessages
  }

  get closeCalled(): boolean {
    return this._closeCalled
  }

  get closeCode(): number | undefined {
    return this._closeCode
  }

  get closeReason(): string | undefined {
    return this._closeReason
  }
}

export class MockWebSocketPair {
  0: MockWebSocket
  1: MockWebSocket

  constructor() {
    this[0] = new MockWebSocket()
    this[1] = new MockWebSocket()
  }
}

export class DurableObject {
  ctx: {
    id: { toString: () => string }
    storage: {
      get: (key: string) => Promise<unknown>
      put: (key: string, value: unknown) => Promise<void>
      getAlarm: () => Promise<number | null>
      setAlarm: (scheduledTime: number) => Promise<void>
    }
    acceptWebSocket: (ws: MockWebSocket, tags?: string[]) => void
    getWebSockets: (tag?: string) => MockWebSocket[]
    setWebSocketAutoResponse: (pair: WebSocketRequestResponsePair) => void
    waitUntil: (promise: Promise<unknown>) => void
  }
  env: unknown

  private _acceptedWebSockets: Array<{ ws: MockWebSocket; tags: string[] }> = []
  private _alarm: number | null = null

  constructor(_ctx: unknown, env: unknown) {
    this.env = env
    this.ctx = {
      id: { toString: () => 'test-do-id' },
      storage: {
        get: () => Promise.resolve(null),
        put: () => Promise.resolve(),
        getAlarm: () => Promise.resolve(this._alarm),
        setAlarm: (scheduledTime: number) => {
          this._alarm = scheduledTime
          return Promise.resolve()
        }
      },
      acceptWebSocket: (ws: MockWebSocket, tags?: string[]) => {
        this._acceptedWebSockets.push({ ws, tags: tags ?? [] })
      },
      getWebSockets: (tag?: string) => {
        if (tag) {
          return this._acceptedWebSockets
            .filter((entry) => entry.tags.includes(tag))
            .map((entry) => entry.ws)
        }
        return this._acceptedWebSockets.map((entry) => entry.ws)
      },
      setWebSocketAutoResponse: () => {},
      waitUntil: (promise: Promise<unknown>) => {
        promise.catch(() => {})
      }
    }
  }
}
