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

const logger = createLogger('AI:ChatServer')

let server: http.Server | null = null
let currentPort: number | null = null

export function getServerPort(): number | null {
  if (!server?.listening) return null
  return currentPort
}

export async function startChatServer(settings: AIInlineSettings): Promise<number> {
  if (server) {
    await stopChatServer()
  }

  const model = createLanguageModel(settings)

  return new Promise((resolve, reject) => {
    server = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

      if (req.method === 'OPTIONS') {
        res.writeHead(200)
        res.end()
        return
      }

      if (req.method === 'POST' && req.url === '/api/ai/chat') {
        await handleChatRequest(req, res, model)
        return
      }

      res.writeHead(404)
      res.end('Not found')
    })

    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address()
      if (addr && typeof addr === 'object') {
        currentPort = addr.port
        logger.info(`Started on port ${currentPort}`)
        resolve(currentPort)
      } else {
        reject(new Error('Failed to get server address'))
      }
    })

    server.on('error', (err) => {
      logger.error('Server error:', err)
      reject(err)
    })
  })
}

export async function stopChatServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve()
      return
    }
    server.close(() => {
      server = null
      currentPort = null
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
