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
      toolChoice: 'required'
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
})
