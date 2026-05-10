import http from 'node:http'

import { createLogger } from '../../lib/logger'
import { createMcpSession } from './session'

const logger = createLogger('AgentMcpServer')

export interface ToolRegistration {
  name: string
  description: string
  inputSchema: unknown
  handler: (
    input: unknown,
    ctx: { conversationId: string | null; windowId: string | null }
  ) => Promise<unknown>
}

export interface StartOptions {
  toolRegistrations: ToolRegistration[]
}

export interface AgentMcpServerHandle {
  readonly url: string
  readonly token: string
  rotateToken(): string
  registerTool(reg: ToolRegistration): void
  stop(): Promise<void>
}

export async function startAgentMcpServer(opts: StartOptions): Promise<AgentMcpServerHandle> {
  const session = createMcpSession()
  const tools = new Map<string, ToolRegistration>()
  for (const reg of opts.toolRegistrations) tools.set(reg.name, reg)

  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization
    const bearer = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined
    if (!session.verifyToken(bearer)) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not_found' }))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const addr = server.address()
  if (!addr || typeof addr !== 'object') {
    server.close()
    throw new Error('Failed to bind agent MCP server')
  }
  const url = `http://127.0.0.1:${addr.port}`
  logger.info(`Agent MCP server listening on ${url}`)

  return {
    url,
    get token() {
      return session.token
    },
    rotateToken: () => session.rotateToken(),
    registerTool(reg) {
      tools.set(reg.name, reg)
    },
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      logger.info('Agent MCP server stopped')
    }
  }
}
