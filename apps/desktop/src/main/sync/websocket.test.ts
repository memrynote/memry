import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  WebSocketManager,
  CLOSE_CODE_VERSION_INCOMPATIBLE,
  type WebSocketManagerDeps
} from './websocket'
import { CertificatePinningError } from './certificate-pinning'

const { MockWebSocket, getInstances, resetInstances } = vi.hoisted(() => {
  const { EventEmitter: EE } = require('events') as typeof import('events')
  const instances: Array<InstanceType<typeof MockWS>> = []

  class MockWS extends EE {
    static OPEN = 1
    static CONNECTING = 0
    static CLOSING = 2
    static CLOSED = 3

    readyState = MockWS.CONNECTING
    terminate = vi.fn(() => {
      this.readyState = MockWS.CLOSED
    })
    close = vi.fn()
    send = vi.fn()

    constructor(
      public url: string,
      public options?: { headers?: Record<string, string> }
    ) {
      super()
      instances.push(this)
    }

    simulateOpen(): void {
      this.readyState = MockWS.OPEN
      this.emit('open')
    }

    simulateMessage(data: Record<string, unknown>): void {
      this.emit('message', JSON.stringify(data))
    }

    simulateTextMessage(text: string): void {
      this.emit('message', text)
    }

    simulatePing(): void {
      this.emit('ping')
    }

    simulateClose(code = 1000): void {
      this.readyState = MockWS.CLOSED
      this.emit('close', code, Buffer.from(''))
    }

    simulateError(err: Error): void {
      this.emit('error', err)
    }

    simulateUnexpectedResponse(statusCode: number, statusMessage?: string): void {
      this.emit(
        'unexpected-response',
        {} as unknown,
        {
          statusCode,
          statusMessage: statusMessage ?? `HTTP ${statusCode}`
        } as unknown
      )
    }
  }

  return {
    MockWebSocket: MockWS,
    getInstances: () => instances,
    resetInstances: () => {
      instances.length = 0
    }
  }
})

vi.mock('ws', () => ({ default: MockWebSocket }))

function lastWs() {
  const all = getInstances()
  return all[all.length - 1]
}

function createMockDeps(overrides?: Partial<WebSocketManagerDeps>): WebSocketManagerDeps {
  return {
    getAccessToken: vi.fn().mockResolvedValue('test-token'),
    getAppVersion: vi.fn().mockReturnValue('1.0.0'),
    isOnline: vi.fn().mockReturnValue(true),
    serverUrl: 'http://localhost:8787',
    ...overrides
  }
}

describe('WebSocketManager', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetInstances()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('#given valid deps #when connect', () => {
    it('#then establishes WebSocket with auth header', async () => {
      const manager = new WebSocketManager(createMockDeps())
      await manager.connect()

      expect(lastWs().url).toBe('ws://localhost:8787/sync/ws')
      expect(lastWs().options?.headers?.Authorization).toBe('Bearer test-token')
    })

    it('#then emits connected on open', async () => {
      const manager = new WebSocketManager(createMockDeps())
      const spy = vi.fn()
      manager.on('connected', spy)

      await manager.connect()
      lastWs().simulateOpen()

      expect(spy).toHaveBeenCalledOnce()
      expect(manager.connected).toBe(true)
    })

    it('#then resets reconnect counter on successful open', async () => {
      const manager = new WebSocketManager(createMockDeps())
      await manager.connect()
      lastWs().simulateOpen()
      lastWs().simulateClose()

      await vi.advanceTimersByTimeAsync(2_000)
      lastWs().simulateOpen()
      lastWs().simulateClose()

      await vi.advanceTimersByTimeAsync(2_000)
      expect(getInstances().length).toBe(3)
    })
  })

  describe('#given connected WebSocket #when message received', () => {
    it('#then parses and emits message event', async () => {
      const manager = new WebSocketManager(createMockDeps())
      const spy = vi.fn()
      manager.on('message', spy)

      await manager.connect()
      lastWs().simulateOpen()
      lastWs().simulateMessage({ type: 'changes_available', payload: { cursor: 5 } })

      expect(spy).toHaveBeenCalledWith({
        type: 'changes_available',
        payload: { cursor: 5 }
      })
    })

    it('#then resets heartbeat timer', async () => {
      const manager = new WebSocketManager(createMockDeps())
      await manager.connect()
      const ws = lastWs()
      ws.simulateOpen()

      await vi.advanceTimersByTimeAsync(25_000)
      ws.simulateMessage({ type: 'heartbeat' })
      await vi.advanceTimersByTimeAsync(25_000)

      expect(ws.terminate).not.toHaveBeenCalled()
    })
  })

  describe('#given connected WebSocket #when heartbeat timeout fires', () => {
    it('#then terminates connection after 31s', async () => {
      const manager = new WebSocketManager(createMockDeps())
      await manager.connect()
      const ws = lastWs()
      ws.simulateOpen()

      await vi.advanceTimersByTimeAsync(31_000)

      expect(ws.terminate).toHaveBeenCalled()
    })
  })

  describe('#given connected WebSocket #when ping received', () => {
    it('#then resets heartbeat timeout', async () => {
      const manager = new WebSocketManager(createMockDeps())
      await manager.connect()
      const ws = lastWs()
      ws.simulateOpen()

      await vi.advanceTimersByTimeAsync(25_000)
      ws.simulatePing()
      await vi.advanceTimersByTimeAsync(25_000)

      expect(ws.terminate).not.toHaveBeenCalled()
    })
  })

  describe('#given connected WebSocket #when connection closes', () => {
    it('#then emits disconnected', async () => {
      const manager = new WebSocketManager(createMockDeps())
      const spy = vi.fn()
      manager.on('disconnected', spy)

      await manager.connect()
      lastWs().simulateOpen()
      lastWs().simulateClose()

      expect(spy).toHaveBeenCalled()
      expect(manager.connected).toBe(false)
    })

    it('#then schedules reconnect with backoff', async () => {
      const manager = new WebSocketManager(createMockDeps())
      await manager.connect()
      lastWs().simulateOpen()
      lastWs().simulateClose()

      expect(getInstances().length).toBe(1)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(getInstances().length).toBe(2)
    })
  })

  describe('#given offline #when connect called', () => {
    it('#then skips WebSocket creation and schedules reconnect', async () => {
      const deps = createMockDeps({ isOnline: vi.fn().mockReturnValue(false) })
      const manager = new WebSocketManager(deps)

      await manager.connect()

      expect(getInstances().length).toBe(0)
      expect(manager.connected).toBe(false)
    })
  })

  describe('#given no access token #when connect called', () => {
    it('#then emits error and schedules reconnect', async () => {
      const deps = createMockDeps({ getAccessToken: vi.fn().mockResolvedValue(null) })
      const manager = new WebSocketManager(deps)
      const spy = vi.fn()
      manager.on('error', spy)

      await manager.connect()

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'No access token available' })
      )
      expect(getInstances().length).toBe(0)
    })
  })

  describe('#given connected #when disconnect called', () => {
    it('#then cleans up and prevents reconnect', async () => {
      const manager = new WebSocketManager(createMockDeps())
      await manager.connect()
      const ws = lastWs()
      ws.simulateOpen()

      manager.disconnect()

      expect(manager.connected).toBe(false)
      expect(ws.terminate).toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(60_000)
      expect(getInstances().length).toBe(1)
    })
  })

  describe('#given WebSocket error #when error occurs', () => {
    it('#then emits error event', async () => {
      const manager = new WebSocketManager(createMockDeps())
      const spy = vi.fn()
      manager.on('error', spy)

      await manager.connect()
      lastWs().simulateError(new Error('Connection refused'))

      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ message: 'Connection refused' }))
    })
  })

  describe('#given https server URL #when connecting', () => {
    it('#then converts to wss protocol', async () => {
      const deps = createMockDeps({ serverUrl: 'https://sync.memrynote.com' })
      const manager = new WebSocketManager(deps)

      await manager.connect()

      expect(lastWs().url).toBe('wss://sync.memrynote.com/sync/ws')
    })
  })

  describe('#given already connected #when connect called again', () => {
    it('#then does not create duplicate connection', async () => {
      const manager = new WebSocketManager(createMockDeps())
      await manager.connect()
      lastWs().simulateOpen()

      await manager.connect()

      expect(getInstances().length).toBe(1)
    })
  })

  describe('#given connected WebSocket #when ping interval fires', () => {
    it('#then sends text ping every 25s', async () => {
      const manager = new WebSocketManager(createMockDeps())
      await manager.connect()
      const ws = lastWs()
      ws.simulateOpen()

      await vi.advanceTimersByTimeAsync(25_000)

      expect(ws.send).toHaveBeenCalledWith('ping')
      expect(ws.send).toHaveBeenCalledTimes(1)

      ws.simulateTextMessage('pong')
      await vi.advanceTimersByTimeAsync(25_000)

      expect(ws.send).toHaveBeenCalledTimes(2)
    })

    it('#then keeps connection alive when server responds with pong', async () => {
      const manager = new WebSocketManager(createMockDeps())
      await manager.connect()
      const ws = lastWs()
      ws.simulateOpen()

      await vi.advanceTimersByTimeAsync(25_000)
      ws.simulateTextMessage('pong')
      await vi.advanceTimersByTimeAsync(25_000)
      ws.simulateTextMessage('pong')
      await vi.advanceTimersByTimeAsync(25_000)

      expect(ws.terminate).not.toHaveBeenCalled()
    })

    it('#then does not emit message event for pong responses', async () => {
      const manager = new WebSocketManager(createMockDeps())
      const spy = vi.fn()
      manager.on('message', spy)

      await manager.connect()
      const ws = lastWs()
      ws.simulateOpen()

      ws.simulateTextMessage('pong')

      expect(spy).not.toHaveBeenCalled()
    })

    it('#then stops ping timer on disconnect', async () => {
      const manager = new WebSocketManager(createMockDeps())
      await manager.connect()
      const ws = lastWs()
      ws.simulateOpen()

      manager.disconnect()

      ws.send.mockClear()
      await vi.advanceTimersByTimeAsync(50_000)
      expect(ws.send).not.toHaveBeenCalled()
    })
  })

  describe('#given valid deps #when connect — version header (T237a)', () => {
    it('#then sends X-App-Version header', async () => {
      // #given
      const deps = createMockDeps({ getAppVersion: vi.fn().mockReturnValue('2.3.1') })
      const manager = new WebSocketManager(deps)

      // #when
      await manager.connect()

      // #then
      expect(lastWs().options?.headers?.['X-App-Version']).toBe('2.3.1')
    })
  })

  describe('#given server rejects with 426 #when version incompatible (T237b)', () => {
    it('#then emits version_rejected on 426 error', async () => {
      // #given
      const manager = new WebSocketManager(createMockDeps())
      const spy = vi.fn()
      manager.on('version_rejected', spy)

      // #when
      await manager.connect()
      lastWs().simulateUnexpectedResponse(426)

      // #then
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('426'))
    })
  })

  describe('#given server rejects with 426 #when reconnect scheduled (T237c)', () => {
    it('#then does not auto-reconnect after version rejection', async () => {
      // #given
      const manager = new WebSocketManager(createMockDeps())
      await manager.connect()
      lastWs().simulateUnexpectedResponse(426)
      lastWs().simulateClose(1006)

      // #when
      await vi.advanceTimersByTimeAsync(60_000)

      // #then
      expect(getInstances().length).toBe(1)
    })
  })

  describe('#given previous version rejection #when connect called again (T237d)', () => {
    it('#then resets versionRejected flag on new connect()', async () => {
      // #given
      const manager = new WebSocketManager(createMockDeps())
      await manager.connect()
      lastWs().simulateUnexpectedResponse(426)
      lastWs().simulateClose(1006)

      // #when
      await manager.connect()

      // #then — new WS instance created (flag was reset)
      expect(getInstances().length).toBe(2)
    })
  })

  describe('#given server rejects with 401 #when reconnect scheduled', () => {
    it('#then does not auto-reconnect after auth rejection', async () => {
      const manager = new WebSocketManager(createMockDeps())
      await manager.connect()
      lastWs().simulateUnexpectedResponse(401)
      lastWs().simulateClose(1006)

      await vi.advanceTimersByTimeAsync(60_000)

      expect(getInstances().length).toBe(1)
    })
  })

  describe('#given WS close code 4009 #when version rejected via close (T237b-alt)', () => {
    it('#then emits version_rejected and suppresses reconnect', async () => {
      // #given
      const manager = new WebSocketManager(createMockDeps())
      const rejectedSpy = vi.fn()
      const disconnectedSpy = vi.fn()
      manager.on('version_rejected', rejectedSpy)
      manager.on('disconnected', disconnectedSpy)

      // #when
      await manager.connect()
      lastWs().simulateOpen()
      lastWs().simulateClose(CLOSE_CODE_VERSION_INCOMPATIBLE)

      // #then
      expect(rejectedSpy).toHaveBeenCalled()
      expect(disconnectedSpy).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(getInstances().length).toBe(1)
    })
  })

  describe('#given CertificatePinningError #when TLS pin fails (T245f)', () => {
    it('#then emits certificate_pin_failed and prevents reconnect', async () => {
      // #given
      const manager = new WebSocketManager(createMockDeps())
      const pinSpy = vi.fn()
      const errorSpy = vi.fn()
      manager.on('certificate_pin_failed', pinSpy)
      manager.on('error', errorSpy)

      // #when
      await manager.connect()
      const pinErr = new CertificatePinningError(
        'Certificate pin mismatch for sync.memrynote.com',
        'sha256/badHash',
        ['sha256/expectedHash']
      )
      lastWs().simulateError(pinErr)

      // #then
      expect(pinSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          actualHash: 'sha256/badHash',
          expectedHashes: ['sha256/expectedHash']
        })
      )
      expect(errorSpy).not.toHaveBeenCalled()
    })

    it('#then blocks all future connect() calls', async () => {
      // #given
      const manager = new WebSocketManager(createMockDeps())
      await manager.connect()
      lastWs().simulateError(
        new CertificatePinningError('pin mismatch', 'sha256/bad', ['sha256/good'])
      )

      // #when
      await manager.connect()

      // #then — no new WS created
      expect(getInstances().length).toBe(1)
    })

    it('#then does not schedule reconnect after pin failure', async () => {
      // #given
      const manager = new WebSocketManager(createMockDeps())
      await manager.connect()
      lastWs().simulateError(
        new CertificatePinningError('pin mismatch', 'sha256/bad', ['sha256/good'])
      )

      // #when
      await vi.advanceTimersByTimeAsync(120_000)

      // #then
      expect(getInstances().length).toBe(1)
    })
  })
})
