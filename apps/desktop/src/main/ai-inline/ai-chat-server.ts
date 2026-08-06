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
      if (server === nextServer) {
        server = null
        currentPort = null
        currentSettingsKey = null
      }
      logger.error('Server error:', err)
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
  try {
    const body = await readBody(req)
    const { messages, toolDefinitions } = JSON.parse(body)

    const result = streamText({
      model,
      system: aiDocumentFormats.html.systemPrompt,
      messages: await convertToModelMessages(injectDocumentStateMessages(messages)),
      tools: toolDefinitionsToToolSet(toolDefinitions),
      toolChoice: 'required'
    })

    result.pipeUIMessageStreamToResponse(res)
  } catch (error) {
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
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}
