import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { startAgentMcpServer, type AgentMcpServerHandle } from '../server'

describe('Agent MCP HTTP server', () => {
  let handle: AgentMcpServerHandle

  beforeEach(async () => {
    handle = await startAgentMcpServer({ toolRegistrations: [] })
  })

  afterEach(async () => {
    await handle.stop()
  })

  it('binds to 127.0.0.1 on a random port', () => {
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const port = Number(handle.url.split(':').pop())
    expect(Number.isInteger(port)).toBe(true)
    expect(port).toBeGreaterThan(0)
  })

  it('rejects requests with no Authorization header', async () => {
    const r = await fetch(`${handle.url}/mcp`, { method: 'POST', body: '{}' })
    expect(r.status).toBe(401)
  })

  it('rejects requests with a bad bearer token', async () => {
    const r = await fetch(`${handle.url}/mcp`, {
      method: 'POST',
      body: '{}',
      headers: { authorization: 'Bearer wrong-token' }
    })
    expect(r.status).toBe(401)
  })

  it('accepts a request with the right bearer token', async () => {
    const r = await fetch(`${handle.url}/healthz`, {
      headers: { authorization: `Bearer ${handle.token}` }
    })
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body).toEqual({ ok: true })
  })

  it('rotates the bearer token and rejects the previous one', async () => {
    const previous = handle.token
    const next = handle.rotateToken()
    expect(next).not.toBe(previous)
    const r = await fetch(`${handle.url}/healthz`, {
      headers: { authorization: `Bearer ${previous}` }
    })
    expect(r.status).toBe(401)
  })
})

describe('Agent MCP server tool round-trip', () => {
  it('routes a registered tool call through the SDK', async () => {
    const handle = await startAgentMcpServer({
      toolRegistrations: [
        {
          name: 'echo_tool',
          description: 'echo input',
          inputSchema: z.object({ msg: z.string() }),
          handler: async (input) => ({ echoed: (input as { msg: string }).msg })
        }
      ]
    })

    try {
      const r = await fetch(`${handle.url}/mcp`, {
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
          params: { name: 'echo_tool', arguments: { msg: 'hi' } }
        })
      })

      expect(r.status).toBe(200)
      const text = await r.text()
      expect(text).toContain('"echoed":"hi"')
    } finally {
      await handle.stop()
    }
  })

  it('serves overlapping MCP tool calls without sharing a connected transport', async () => {
    let releaseFirst!: () => void
    let resolveFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve
    })
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const handle = await startAgentMcpServer({
      toolRegistrations: [
        {
          name: 'slow_echo_tool',
          description: 'echo input after an optional delay',
          inputSchema: z.object({ msg: z.string() }),
          handler: async (input) => {
            const msg = (input as { msg: string }).msg
            if (msg === 'first') {
              resolveFirstStarted()
              await firstCanFinish
            }
            return { echoed: msg }
          }
        }
      ]
    })

    try {
      const first = callTool(handle, 'slow_echo_tool', { msg: 'first' })
      await firstStarted
      const second = callTool(handle, 'slow_echo_tool', { msg: 'second' })
      await new Promise((resolve) => setTimeout(resolve, 25))
      releaseFirst()

      const [firstResponse, secondResponse] = await Promise.all([first, second])
      expect(firstResponse.status).toBe(200)
      expect(secondResponse.status).toBe(200)
      expect(await firstResponse.text()).toContain('"echoed":"first"')
      expect(await secondResponse.text()).toContain('"echoed":"second"')
    } finally {
      await handle.stop()
    }
  })

  it('decorates memrynote tool results with source refs for MCP clients', async () => {
    const handle = await startAgentMcpServer({
      toolRegistrations: [
        {
          name: 'vault_search_notes',
          description: 'search notes',
          inputSchema: z.object({}),
          handler: async () => [{ id: 'note-1', title: 'Movies', snippet: '', folder_path: null }]
        }
      ]
    })

    try {
      const r = await fetch(`${handle.url}/mcp`, {
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
          params: { name: 'vault_search_notes', arguments: {} }
        })
      })

      expect(r.status).toBe(200)
      const text = await r.text()
      expect(text).toContain('"href":"memry://note/note-1"')
      expect(text).toContain('"source_ref"')
    } finally {
      await handle.stop()
    }
  })

  it('replaces an existing tool registration for gate updates', async () => {
    const handle = await startAgentMcpServer({
      toolRegistrations: [
        {
          name: 'replaceable_tool',
          description: 'first handler',
          inputSchema: z.object({}),
          handler: async () => ({ version: 'first' })
        }
      ]
    })

    try {
      handle.registerTool({
        name: 'replaceable_tool',
        description: 'second handler',
        inputSchema: z.object({}),
        handler: async () => ({ version: 'second' })
      })

      const r = await fetch(`${handle.url}/mcp`, {
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
          params: { name: 'replaceable_tool', arguments: {} }
        })
      })

      expect(r.status).toBe(200)
      const text = await r.text()
      expect(text).toContain('"version":"second"')
    } finally {
      await handle.stop()
    }
  })
})

describe('Agent MCP server shutdown', () => {
  it('stops while a tool call is still in flight', async () => {
    let releaseHandler!: () => void
    let markHandlerStarted!: () => void
    const handlerStarted = new Promise<void>((resolve) => {
      markHandlerStarted = resolve
    })
    const handlerCanFinish = new Promise<void>((resolve) => {
      releaseHandler = resolve
    })
    const handle = await startAgentMcpServer({
      toolRegistrations: [
        {
          name: 'stuck_tool',
          description: 'blocks until released',
          inputSchema: z.object({}),
          handler: async () => {
            markHandlerStarted()
            await handlerCanFinish
            return {}
          }
        }
      ]
    })
    const inFlight = callTool(handle, 'stuck_tool', {}).catch(() => undefined)
    await handlerStarted

    try {
      await expect(withDeadline(handle.stop(), 3000)).resolves.toBe('stopped')
    } finally {
      releaseHandler()
      await inFlight
    }
  })
})

function withDeadline(promise: Promise<unknown>, ms: number): Promise<'stopped'> {
  let timer: NodeJS.Timeout
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`stop() did not resolve within ${ms}ms`)), ms)
  })
  return Promise.race([promise.then(() => 'stopped' as const), deadline]).finally(() =>
    clearTimeout(timer)
  )
}

function callTool(
  handle: AgentMcpServerHandle,
  name: string,
  args: Record<string, unknown>
): Promise<Response> {
  return fetch(`${handle.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${handle.token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'tools/call',
      params: { name, arguments: args }
    })
  })
}
