/**
 * IPC communication mocks for testing handlers.
 * Simulates ipcMain.handle and ipcRenderer.invoke behavior.
 */

import { vi, beforeEach } from 'vitest'

// ============================================================================
// Types
// ============================================================================

type IpcHandler = (event: MockIpcMainInvokeEvent, ...args: unknown[]) => unknown

export interface MockIpcMainInvokeEvent {
  sender: {
    id: number
    send: ReturnType<typeof vi.fn>
  }
  senderFrame: {
    url: string
    routingId: number
  }
  frameId: number
  processId: number
  defaultPrevented: boolean
  preventDefault: () => void
}

// ============================================================================
// IPC Main Mock
// ============================================================================

const handlers = new Map<string, IpcHandler>()

export const mockIpcMain = {
  /**
   * Register a handler for a channel.
   */
  handle: vi.fn((channel: string, handler: IpcHandler) => {
    handlers.set(channel, handler)
  }),

  /**
   * Register a one-time handler for a channel.
   */
  handleOnce: vi.fn((channel: string, handler: IpcHandler) => {
    const wrappedHandler: IpcHandler = (...args) => {
      handlers.delete(channel)
      return handler(...args)
    }
    handlers.set(channel, wrappedHandler)
  }),

  /**
   * Remove a handler for a channel.
   */
  removeHandler: vi.fn((channel: string) => {
    handlers.delete(channel)
  }),

  /**
   * Event listeners (for ipcMain.on)
   */
  on: vi.fn(),
  once: vi.fn(),
  removeListener: vi.fn(),
  removeAllListeners: vi.fn(),

  /**
   * Clear all registered handlers.
   */
  _clearHandlers: () => {
    handlers.clear()
  },

  /**
   * Get a registered handler.
   */
  _getHandler: (channel: string) => handlers.get(channel)
}

// ============================================================================
// IPC Renderer Mock
// ============================================================================

export const mockIpcRenderer = {
  /**
   * Invoke a handler registered with ipcMain.handle.
   */
  invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel)
    if (!handler) {
      throw new Error(`No handler registered for channel: ${channel}`)
    }

    const event = createMockIpcMainInvokeEvent()
    return handler(event, ...args)
  }),

  /**
   * Send a message to the main process.
   */
  send: vi.fn(),
  sendSync: vi.fn(),
  sendToHost: vi.fn(),

  /**
   * Event listeners.
   */
  on: vi.fn().mockReturnValue(() => {}),
  once: vi.fn(),
  removeListener: vi.fn(),
  removeAllListeners: vi.fn()
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a mock IPC event object.
 */
export function createMockIpcMainInvokeEvent(senderId = 1): MockIpcMainInvokeEvent {
  return {
    sender: {
      id: senderId,
      send: vi.fn()
    },
    senderFrame: {
      url: 'file:///mock/index.html',
      routingId: 1
    },
    frameId: 1,
    processId: 1,
    defaultPrevented: false,
    preventDefault: vi.fn()
  }
}

/**
 * Simulate invoking an IPC handler directly.
 * Useful for testing handlers without going through the full IPC stack.
 */
export async function invokeHandler<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`No handler registered for channel: ${channel}`)
  }

  const event = createMockIpcMainInvokeEvent()
  return handler(event, ...args) as Promise<T>
}

/**
 * Register a test handler.
 * Use this to set up expected responses in tests.
 */
export function registerTestHandler(
  channel: string,
  response: unknown | ((event: MockIpcMainInvokeEvent, ...args: unknown[]) => unknown)
): void {
  const handler = typeof response === 'function' ? (response as IpcHandler) : () => response

  handlers.set(channel, handler)
}

/**
 * Reset all IPC mocks and handlers.
 */
export function resetIpcMocks(): void {
  handlers.clear()
  mockIpcMain.handle.mockClear()
  mockIpcMain.handleOnce.mockClear()
  mockIpcMain.removeHandler.mockClear()
  mockIpcRenderer.invoke.mockClear()
  mockIpcRenderer.send.mockClear()
}

// ============================================================================
// Testing Utilities
// ============================================================================

/**
 * Create a test harness for IPC handlers.
 * Provides a clean environment for testing handler functions.
 */
export function createIpcTestHarness() {
  // Clear handlers before each test
  beforeEach(() => {
    handlers.clear()
    resetIpcMocks()
  })

  return {
    mockIpcMain,
    mockIpcRenderer,
    invokeHandler,
    registerTestHandler,
    createMockIpcMainInvokeEvent
  }
}
