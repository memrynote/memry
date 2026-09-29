import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const mocks = vi.hoisted(() => ({
  trackMainError: vi.fn(),
  trackMainLog: vi.fn()
}))

vi.mock('../../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

vi.mock('../../../telemetry/diagnostics', () => ({
  trackMainError: mocks.trackMainError,
  trackMainLog: mocks.trackMainLog
}))

vi.mock('../../../telemetry/redact-options', () => ({
  getMainRedactOptions: () => ({})
}))

import { AgentToolError, type AgentToolErrorCode } from '../errors'
import { startAgentMcpServer, type AgentMcpServerHandle } from '../server'

/**
 * Tool failures file into Error Tracking only when they are faults (#2524).
 * A model asking for a missing note or sending bad input recovers on its own,
 * so those stay warn-level; INTERNAL ships its message so the issue is triageable.
 */
describe('Agent MCP server tool failure telemetry', () => {
  let handle: AgentMcpServerHandle
  let failure: unknown

  beforeEach(async () => {
    mocks.trackMainLog.mockClear()
    handle = await startAgentMcpServer({
      toolRegistrations: [
        {
          name: 'failing_tool',
          description: 'always fails',
          inputSchema: z.object({}),
          handler: async () => {
            throw failure
          }
        }
      ]
    })
  })

  afterEach(async () => {
    await handle.stop()
  })

  const callFailingTool = async (): Promise<string> => {
    const response = await fetch(`${handle.url}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${handle.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'failing_tool', arguments: {} }
      })
    })
    return response.text()
  }

  it('reports an unexpected throw as an INTERNAL error carrying its message', async () => {
    failure = new Error('database is locked')

    const body = await callFailingTool()

    expect(body).toContain('INTERNAL')
    expect(mocks.trackMainLog).toHaveBeenCalledTimes(1)
    expect(mocks.trackMainLog).toHaveBeenCalledWith('error', {
      scope: 'AgentMcpServer',
      action: 'tool_failed_failing_tool',
      errorCode: 'INTERNAL',
      error: expect.objectContaining({ message: 'database is locked' })
    })
  })

  it.each<AgentToolErrorCode>(['NOT_FOUND', 'VALIDATION'])(
    'keeps %s as a warn-level log instead of an exception',
    async (code) => {
      failure = new AgentToolError(code, 'model sent a bad reference')

      await callFailingTool()

      expect(mocks.trackMainLog).toHaveBeenCalledTimes(1)
      expect(mocks.trackMainLog).toHaveBeenCalledWith('warn', {
        scope: 'AgentMcpServer',
        action: 'tool_failed_failing_tool',
        errorCode: code
      })
    }
  )

  it('does not report a user denial at all', async () => {
    failure = new AgentToolError('PERMISSION_DENIED', 'User denied request.')

    await callFailingTool()

    expect(mocks.trackMainLog).not.toHaveBeenCalled()
  })
})
