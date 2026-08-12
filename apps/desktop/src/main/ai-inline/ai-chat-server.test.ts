import http from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getServerPort, startChatServer, stopChatServer } from './ai-chat-server'

const mocks = vi.hoisted(() => ({
  model: { id: 'model' },
  createLanguageModel: vi.fn(),
  streamText: vi.fn(),
  convertToModelMessages: vi.fn(),
  injectDocumentStateMessages: vi.fn(),
  toolDefinitionsToToolSet: vi.fn(),
  pipe: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn()
}))

vi.mock('./ai-llm-service', () => ({
  createLanguageModel: (...args: unknown[]) => mocks.createLanguageModel(...args)
}))

vi.mock('ai', () => ({
  streamText: (...args: unknown[]) => mocks.streamText(...args),
  convertToModelMessages: (...args: unknown[]) => mocks.convertToModelMessages(...args)
}))

vi.mock('@blocknote/xl-ai/server', () => ({
  aiDocumentFormats: {
    html: { systemPrompt: 'html-system' }
  },
  injectDocumentStateMessages: (...args: unknown[]) => mocks.injectDocumentStateMessages(...args),
  toolDefinitionsToToolSet: (...args: unknown[]) => mocks.toolDefinitionsToToolSet(...args)
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: (...args: unknown[]) => mocks.logInfo(...args),
    warn: (...args: unknown[]) => mocks.logWarn(...args),
    error: (...args: unknown[]) => mocks.logError(...args)
  })
}))

const settings = {
  enabled: true,
  provider: 'ollama',
  model: 'llama3',
  baseUrl: 'http://localhost:11434',
  apiKey: ''
}

async function postJson(port: number, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

// Declares an oversized body without ever writing it, so the size guard has to
// reject on the header alone.
function postDeclaredLength(
  port: number,
  contentLength: number
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let settled = false
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/ai/chat',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(contentLength) }
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
        })
        res.on('end', () => {
          settled = true
          resolve({ status: res.statusCode ?? 0, body })
        })
      }
    )
    req.on('error', (err) => {
      if (!settled) reject(err)
    })
    // Node only flushes request headers on the first write, and the rest of the
    // declared body is deliberately never sent.
    req.write('{')
  })
}

// Chunked upload with no declared length, and valid JSON so that an
// uncapped server would happily buffer it and reach the model.
function postChunkedJson(port: number, fillerBytes: number): Promise<number | 'errored'> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/ai/chat',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      }
    )
    req.on('error', () => resolve('errored'))

    const chunk = Buffer.alloc(1024 * 1024, 0x61)
    let written = 0
    const pump = (): void => {
      while (written < fillerBytes) {
        if (req.destroyed || req.writableEnded) return
        written += chunk.length
        if (!req.write(chunk)) {
          req.once('drain', pump)
          return
        }
      }
      if (!req.destroyed) req.end('"}],"toolDefinitions":[]}')
    }
    req.write('{"messages":[{"role":"user","content":"')
    pump()
  })
}

describe('AI inline chat server', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createLanguageModel.mockReturnValue(mocks.model)
    mocks.injectDocumentStateMessages.mockImplementation((messages) => messages)
    mocks.convertToModelMessages.mockImplementation(async (messages) => messages)
    mocks.toolDefinitionsToToolSet.mockReturnValue({ insert: { description: 'tool' } })
    mocks.pipe.mockImplementation(
      (res: { writeHead: (status: number) => void; end: (body: string) => void }) => {
        res.writeHead(200)
        res.end('streamed')
      }
    )
    mocks.streamText.mockReturnValue({
      pipeUIMessageStreamToResponse: mocks.pipe
    })
  })

  afterEach(async () => {
    await stopChatServer()
  })

  it('starts, reports its port, handles CORS preflight, and stops', async () => {
    expect(getServerPort()).toBeNull()

    const port = await startChatServer(settings)

    expect(port).toBeGreaterThan(0)
    expect(getServerPort()).toBe(port)
    expect(mocks.createLanguageModel).toHaveBeenCalledWith(settings)

    const response = await fetch(`http://127.0.0.1:${port}/api/ai/chat`, { method: 'OPTIONS' })
    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')

    await stopChatServer()
    expect(getServerPort()).toBeNull()
  })

  it('returns the running port instead of restarting when settings are unchanged', async () => {
    const firstPort = await startChatServer(settings)
    mocks.logInfo.mockClear()

    const secondPort = await startChatServer({ ...settings })

    expect(secondPort).toBe(firstPort)
    expect(getServerPort()).toBe(firstPort)
    expect(mocks.createLanguageModel).toHaveBeenCalledTimes(1)
    expect(mocks.logInfo).not.toHaveBeenCalledWith('Stopped')
  })

  it('coalesces concurrent starts when settings are unchanged', async () => {
    const [firstPort, secondPort] = await Promise.all([
      startChatServer(settings),
      startChatServer({ ...settings })
    ])

    expect(secondPort).toBe(firstPort)
    expect(getServerPort()).toBe(firstPort)
    expect(mocks.createLanguageModel).toHaveBeenCalledTimes(1)
  })

  it('streams valid chat requests through the model and returns 404 for other paths', async () => {
    const port = await startChatServer(settings)

    const response = await postJson(port, {
      messages: [{ role: 'user', content: 'hello' }],
      toolDefinitions: [{ name: 'insert' }]
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('streamed')
    expect(mocks.streamText).toHaveBeenCalledWith({
      model: mocks.model,
      system: 'html-system',
      messages: [{ role: 'user', content: 'hello' }],
      tools: { insert: { description: 'tool' } },
      toolChoice: 'required',
      abortSignal: expect.any(AbortSignal)
    })

    const missing = await fetch(`http://127.0.0.1:${port}/nope`, { method: 'POST' })
    expect(missing.status).toBe(404)
    expect(await missing.text()).toBe('Not found')
  })

  it('returns internal errors for invalid request bodies and replaces an existing server on restart', async () => {
    const firstPort = await startChatServer(settings)
    const secondPort = await startChatServer({ ...settings, model: 'other' })

    expect(secondPort).toBeGreaterThan(0)
    expect(getServerPort()).toBe(secondPort)
    await expect(fetch(`http://127.0.0.1:${firstPort}/nope`)).rejects.toThrow()

    const response = await fetch(`http://127.0.0.1:${secondPort}/api/ai/chat`, {
      method: 'POST',
      body: '{'
    })

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Internal server error' })
    expect(mocks.logError).toHaveBeenCalledWith('Chat request failed:', expect.any(Error))
  })

  it('aborts the provider request when the client disconnects mid-stream', async () => {
    let capturedSignal: AbortSignal | undefined
    mocks.streamText.mockImplementation((options: { abortSignal: AbortSignal }) => {
      capturedSignal = options.abortSignal
      return { pipeUIMessageStreamToResponse: mocks.pipe }
    })
    // Never end the response: the generation is still in flight.
    mocks.pipe.mockImplementation((res: http.ServerResponse) => {
      res.writeHead(200)
      res.write('partial')
    })

    const port = await startChatServer(settings)
    const controller = new AbortController()
    const response = await fetch(`http://127.0.0.1:${port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [], toolDefinitions: [] }),
      signal: controller.signal
    })
    const drained = response.text().catch(() => undefined)

    await vi.waitFor(() => expect(capturedSignal).toBeDefined())
    expect(capturedSignal?.aborted).toBe(false)

    controller.abort()

    await vi.waitFor(() => expect(capturedSignal?.aborted).toBe(true))
    await drained
  })

  it('stops while a response is still streaming so quit cannot hang', async () => {
    mocks.pipe.mockImplementation((res: http.ServerResponse) => {
      res.writeHead(200)
      res.write('partial')
    })

    const port = await startChatServer(settings)
    const response = await postJson(port, { messages: [], toolDefinitions: [] })
    const drained = response.text().catch(() => undefined)
    expect(response.status).toBe(200)

    // Without closeAllConnections() this never resolves and the before-quit
    // chain stalls until the shutdown timeout force-exits the app.
    await stopChatServer()

    expect(getServerPort()).toBeNull()
    await expect(fetch(`http://127.0.0.1:${port}/nope`)).rejects.toThrow()
    await drained
  })

  it('rejects a body whose declared length exceeds the cap without reading it', async () => {
    const port = await startChatServer(settings)

    const response = await postDeclaredLength(port, 26 * 1024 * 1024)

    expect(response.status).toBe(413)
    expect(JSON.parse(response.body)).toEqual({ error: 'Request body too large' })
    expect(mocks.streamText).not.toHaveBeenCalled()
    expect(mocks.logWarn).toHaveBeenCalledWith('Rejected oversized chat request body')
  })

  it('drops a chunked body that grows past the cap instead of buffering it', async () => {
    const port = await startChatServer(settings)

    const result = await postChunkedJson(port, 26 * 1024 * 1024)

    expect(result).not.toBe(200)
    expect(mocks.streamText).not.toHaveBeenCalled()
  }, 20000)

  it('keeps a listening server closable after a post-listen error', async () => {
    const created: http.Server[] = []
    const createServer = http.createServer.bind(http) as (...args: unknown[]) => http.Server
    const spy = vi.spyOn(http, 'createServer').mockImplementation(((...args: unknown[]) => {
      const instance = createServer(...args)
      created.push(instance)
      return instance
    }) as typeof http.createServer)

    try {
      const port = await startChatServer(settings)
      expect(created).toHaveLength(1)

      // A late socket error must not make the module forget a bound server, or
      // stopChatServer() resolves without closing it and the port leaks.
      created[0].emit('error', new Error('late socket failure'))

      expect(getServerPort()).toBe(port)
      await stopChatServer()
      expect(getServerPort()).toBeNull()
      await expect(fetch(`http://127.0.0.1:${port}/nope`)).rejects.toThrow()
    } finally {
      spy.mockRestore()
    }
  })
})
