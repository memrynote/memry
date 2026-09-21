import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { createBridge } from '../agy-mcp-bridge'

interface Captured {
  headers: http.IncomingHttpHeaders
  body: string
}

let server: http.Server | null = null

afterEach(async () => {
  const running = server
  server = null
  if (running) await new Promise<void>((resolve) => running.close(() => resolve()))
})

async function startServer(
  respond: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<{ url: string; captured: Captured[] }> {
  const captured: Captured[] = []
  const created = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += String(chunk)
    })
    req.on('end', () => {
      captured.push({ headers: req.headers, body })
      respond(req, res)
    })
  })
  server = created
  await new Promise<void>((resolve) => created.listen(0, '127.0.0.1', () => resolve()))
  const { port } = created.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/mcp`, captured }
}

describe('createBridge', () => {
  it('carries the turn credentials as headers and relays a JSON reply', async () => {
    const { url, captured } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }))
    })
    const written: unknown[] = []
    const bridge = createBridge(
      { url, token: 'session-token', writeGrant: 'turn-grant-1', windowId: 'window-1' },
      (message) => written.push(message)
    )

    await bridge.handle('{"jsonrpc":"2.0","id":1,"method":"tools/list"}')

    // These three headers are the entire reason the bridge exists: the config
    // file agy reads cannot express them.
    expect(captured[0].headers.authorization).toBe('Bearer session-token')
    expect(captured[0].headers['x-memry-turn']).toBe('turn-grant-1')
    expect(captured[0].headers['x-memry-window']).toBe('window-1')
    expect(JSON.parse(captured[0].body)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list'
    })
    expect(written).toEqual([{ jsonrpc: '2.0', id: 1, result: { tools: [] } }])
  })

  it('relays every frame of an SSE reply', async () => {
    const { url } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: message\n')
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { ok: true } })}\n\n`)
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/x' })}\n\n`)
      res.end()
    })
    const written: unknown[] = []
    const bridge = createBridge({ url, token: 'session-token' }, (message) => written.push(message))

    await bridge.handle('{"jsonrpc":"2.0","id":2,"method":"tools/call"}')

    expect(written).toEqual([
      { jsonrpc: '2.0', id: 2, result: { ok: true } },
      { jsonrpc: '2.0', method: 'notifications/x' }
    ])
  })

  it('omits the write grant header when the run has none', async () => {
    const { url, captured } = await startServer((_req, res) => {
      res.writeHead(202).end()
    })
    const bridge = createBridge({ url, token: 'session-token' }, () => {})

    await bridge.handle('{"jsonrpc":"2.0","id":3,"method":"ping"}')

    expect(captured[0].headers['x-memry-turn']).toBeUndefined()
  })

  it('answers with an explanation when no turn is running', async () => {
    const written: unknown[] = []
    const bridge = createBridge({ url: undefined, token: undefined }, (message) =>
      written.push(message)
    )

    await bridge.handle('{"jsonrpc":"2.0","id":4,"method":"tools/list"}')

    // The user's own `agy` sessions see this server too; it has to say why the
    // tools are inert rather than hang or crash the session.
    expect(written).toEqual([
      {
        jsonrpc: '2.0',
        id: 4,
        error: { code: -32000, message: expect.stringContaining('not running an agent turn') }
      }
    ])
  })

  it('stays silent for a notification it cannot forward', async () => {
    const written: unknown[] = []
    const bridge = createBridge({ url: undefined, token: undefined }, (message) =>
      written.push(message)
    )

    await bridge.handle('{"jsonrpc":"2.0","method":"notifications/initialized"}')

    expect(written).toEqual([])
  })

  it('reports an HTTP failure as a JSON-RPC error', async () => {
    const { url } = await startServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}')
    })
    const written: unknown[] = []
    const bridge = createBridge({ url, token: 'stale' }, (message) => written.push(message))

    await bridge.handle('{"jsonrpc":"2.0","id":5,"method":"tools/list"}')

    expect(written).toEqual([
      {
        jsonrpc: '2.0',
        id: 5,
        error: { code: -32000, message: 'Memry responded 401' }
      }
    ])
  })

  it('reports an unreachable app instead of exiting', async () => {
    const written: unknown[] = []
    const bridge = createBridge(
      { url: 'http://127.0.0.1:1/mcp', token: 'session-token' },
      (message) => written.push(message)
    )

    await bridge.handle('{"jsonrpc":"2.0","id":6,"method":"tools/list"}')

    expect(written).toMatchObject([
      { id: 6, error: { message: expect.stringContaining('Could not reach Memry') } }
    ])
  })

  it('reports an unparseable line as a parse error', async () => {
    const written: unknown[] = []
    const bridge = createBridge({ url: undefined, token: undefined }, (message) =>
      written.push(message)
    )

    await bridge.handle('not json')

    expect(written).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }
    ])
  })
})
