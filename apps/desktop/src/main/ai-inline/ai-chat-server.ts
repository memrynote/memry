import http from 'node:http'
import { streamText, convertToModelMessages } from 'ai'
import {
  aiDocumentFormats,
  injectDocumentStateMessages,
  toolDefinitionsToToolSet
} from '@blocknote/xl-ai/server'

import { createLanguageModel } from './ai-llm-service'
import type { AIInlineSettings } from '@memry/contracts/ai-inline-channels'
import { createLogger } from '../lib/logger'
import { trackMainError } from '../telemetry/diagnostics'

const logger = createLogger('AI:ChatServer')

// Same ceiling as the capture server: enough for a large document plus its
// conversation, small enough that a runaway client cannot exhaust main-process
// memory before the socket is dropped.
const MAX_BODY_BYTES = 25 * 1024 * 1024

class PayloadTooLargeError extends Error {
  constructor() {
    super('Request body too large')
    this.name = 'PayloadTooLargeError'
  }
}

let server: http.Server | null = null
let currentPort: number | null = null
let currentSettingsKey: string | null = null
let startInFlight: { key: string; promise: Promise<number> } | null = null

function getSettingsKey(settings: AIInlineSettings): string {
  return JSON.stringify({
    enabled: settings.enabled,
    provider: settings.provider,
    model: settings.model,
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl
  })
}

function getRunningPortFor(settingsKey: string): number | null {
  if (!server?.listening) return null
  if (currentPort === null || currentSettingsKey !== settingsKey) return null
  return currentPort
}

export function getServerPort(): number | null {
  if (!server?.listening) return null
  return currentPort
}

export async function startChatServer(settings: AIInlineSettings): Promise<number> {
  const settingsKey = getSettingsKey(settings)
  const runningPort = getRunningPortFor(settingsKey)
  if (runningPort !== null) {
    return runningPort
  }

  if (startInFlight) {
    if (startInFlight.key === settingsKey) {
      return startInFlight.promise
    }

    await startInFlight.promise.catch(() => undefined)
    const portAfterPendingStart = getRunningPortFor(settingsKey)
    if (portAfterPendingStart !== null) {
      return portAfterPendingStart
    }
  }

  if (server) {
    await stopChatServer()
  }

  const model = createLanguageModel(settings)
  const startPromise = new Promise<number>((resolve, reject) => {
    const nextServer = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

      if (req.method === 'OPTIONS') {
        res.writeHead(200)
        res.end()
        return
      }

      if (req.method === 'POST' && req.url === '/api/ai/chat') {
        handleChatRequest(req, res, model).catch((err) => {
          logger.error('Unhandled chat request error:', err)
          trackMainError('ai_inline', 'inline_chat_request_unhandled', err)
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
          }
          res.end(JSON.stringify({ error: 'Internal server error' }))
        })
        return
      }

      res.writeHead(404)
      res.end('Not found')
    })

    server = nextServer
    currentPort = null
    currentSettingsKey = null

    nextServer.listen(0, '127.0.0.1', () => {
      const addr = nextServer.address()
      if (addr && typeof addr === 'object') {
        currentPort = addr.port
        currentSettingsKey = settingsKey
        logger.info(`Started on port ${currentPort}`)
        resolve(currentPort)
      } else {
        reject(new Error('Failed to get server address'))
      }
    })

    nextServer.on('error', (err) => {
      logger.error('Server error:', err)
      // Only a server that never reached listening is safe to forget. Nulling a
      // bound server here would make stopChatServer() resolve without closing
      // it, leaking the listening socket for the rest of the process lifetime.
      if (server === nextServer && !nextServer.listening) {
        server = null
        currentPort = null
        currentSettingsKey = null
      }
      reject(err)
    })
  })

  startInFlight = { key: settingsKey, promise: startPromise }

  try {
    return await startPromise
  } finally {
    if (startInFlight?.promise === startPromise) {
      startInFlight = null
    }
  }
}

export async function stopChatServer(): Promise<void> {
  const pendingStart = startInFlight?.promise
  if (pendingStart) {
    await pendingStart.catch(() => undefined)
  }

  return new Promise((resolve) => {
    if (!server) {
      currentPort = null
      currentSettingsKey = null
      resolve()
      return
    }

    const closingServer = server
    if (!closingServer.listening) {
      if (server === closingServer) {
        server = null
        currentPort = null
        currentSettingsKey = null
      }
      resolve()
      return
    }

    // close() only refuses new connections and drops idle ones. A socket still
    // streaming a generation would keep it pending forever, stalling the
    // before-quit chain until the 5s shutdown timeout force-exits the app.
    closingServer.closeAllConnections?.()
    closingServer.close(() => {
      if (server === closingServer) {
        server = null
        currentPort = null
        currentSettingsKey = null
      }
      logger.info('Stopped')
      resolve()
    })
  })
}

async function handleChatRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  model: ReturnType<typeof createLanguageModel>
): Promise<void> {
  // Dismissing the inline AI menu just drops the renderer's fetch. Without this
  // the provider request keeps generating into a dead socket until the model
  // finishes. 'close' also fires on a completed response, so writableFinished
  // tells a normal finish apart from a client that went away.
  const abortController = new AbortController()
  res.on('close', () => {
    if (!res.writableFinished) abortController.abort()
  })

  try {
    const body = await readBody(req)
    const { messages, toolDefinitions } = JSON.parse(body)

    const result = streamText({
      model,
      system: aiDocumentFormats.html.systemPrompt,
      messages: await convertToModelMessages(injectDocumentStateMessages(messages)),
      tools: toolDefinitionsToToolSet(toolDefinitions),
      toolChoice: 'required',
      abortSignal: abortController.signal
    })

    result.pipeUIMessageStreamToResponse(res)
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      logger.warn('Rejected oversized chat request body')
      if (!res.headersSent) {
        res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' })
      }
      res.end(JSON.stringify({ error: 'Request body too large' }))
      return
    }

    logger.error('Chat request failed:', error)
    trackMainError('ai_inline', 'inline_chat_request', error)
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
    }
    res.end(JSON.stringify({ error: 'Internal server error' }))
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    // Reject before a single byte is buffered when the client declares an
    // oversized body; the streaming guard below covers chunked bodies and
    // clients that under-declare their length.
    const declaredLength = Number(req.headers['content-length'])
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      reject(new PayloadTooLargeError())
      return
    }

    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new PayloadTooLargeError())
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}
