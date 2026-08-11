import http from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  trackMainError: vi.fn(),
  trackMainLog: vi.fn()
}))

vi.mock('../../../lib/logger', () => ({
  createLogger: () => ({
    info: mocks.logInfo,
    warn: mocks.logWarn,
    error: mocks.logError
  })
}))

vi.mock('../../../telemetry/diagnostics', () => ({
  trackMainError: mocks.trackMainError,
  trackMainLog: mocks.trackMainLog
}))

import { startAgentMcpServer, type AgentMcpServerHandle } from '../server'

/**
 * A server-level 'error' after listen has no listener once the listen-only one
 * is removed, so EventEmitter throws it out of Node's own `onconnection`
 * callback. In the app that lands in main/index.ts's uncaughtException handler,
 * which only reports telemetry — the process survives, nothing reaches the log
 * file, and the report is filed under `main_process:uncaught_exception` with no
 * hint that the MCP endpoint was involved.
 */
describe('Agent MCP server late errors', () => {
  let handle: AgentMcpServerHandle
  let server: http.Server

  beforeEach(async () => {
    mocks.logError.mockClear()
    mocks.trackMainError.mockClear()

    // Real server, real listen — the spy only hands the test the instance so it
    // can emit on it the way Node's accept path does.
    const created: http.Server[] = []
    const realCreateServer = http.createServer
    const spy = vi.spyOn(http, 'createServer').mockImplementation(((...args: unknown[]) => {
      const instance = (realCreateServer as (...a: unknown[]) => http.Server)(...args)
      created.push(instance)
      return instance
    }) as typeof http.createServer)
    try {
      handle = await startAgentMcpServer({ toolRegistrations: [] })
    } finally {
      spy.mockRestore()
    }
    server = created[0]
  })

  afterEach(async () => {
    if (server.listening) await handle.stop()
  })

  it('logs and reports a post-listen server error instead of throwing out of the emit', async () => {
    // #given the error Node's net.js onconnection() builds and emits on the
    // server when accept(2) fails after listen
    const acceptError = Object.assign(new Error('accept EMFILE'), {
      code: 'EMFILE',
      syscall: 'accept'
    })

    // #when the listening server emits it
    expect(() => server.emit('error', acceptError)).not.toThrow()

    // #then it is surfaced under this server's own scope, not swallowed into
    // the generic uncaughtException bucket
    expect(mocks.logError).toHaveBeenCalledWith('Agent MCP server error', acceptError)
    expect(mocks.trackMainError).toHaveBeenCalledWith('agent', 'mcp_server', acceptError)

    // #and the endpoint stays up: an accept failure is per-connection, the
    // listening socket is untouched, so Agent Chat keeps working
    expect(server.listening).toBe(true)
    const response = await fetch(`${handle.url}/healthz`, {
      headers: { authorization: `Bearer ${handle.token}` }
    })
    expect(response.status).toBe(200)
  })

  it('still stops cleanly after a late error, and the next start binds a fresh server', async () => {
    server.emit('error', new Error('accept ENOBUFS'))

    await handle.stop()
    expect(server.listening).toBe(false)

    const next = await startAgentMcpServer({ toolRegistrations: [] })
    try {
      expect(next.url).not.toBe(handle.url)
      const response = await fetch(`${next.url}/healthz`, {
        headers: { authorization: `Bearer ${next.token}` }
      })
      expect(response.status).toBe(200)
    } finally {
      await next.stop()
    }
  })
})
