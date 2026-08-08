import http from 'node:http'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { ZodTypeAny } from 'zod'

import { createLogger } from '../../lib/logger'
import { trackMainError, trackMainLog } from '../../telemetry/diagnostics'
import { decorateToolResultWithAgentSources } from '../source-refs'
import { AgentToolError, toMcpToolErrorContent } from './errors'
import { createMcpSession } from './session'

const logger = createLogger('AgentMcpServer')

export interface ToolRegistration {
  name: string
  description: string
  inputSchema: ZodTypeAny
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

  function bindTool(reg: ToolRegistration): void {
    tools.set(reg.name, reg)
  }

  for (const reg of opts.toolRegistrations) bindTool(reg)

  function createMcpServer(): McpServer {
    const mcp = new McpServer({ name: 'memry-vault', version: '1.0.0' })
    for (const reg of tools.values()) {
      mcp.registerTool(
        reg.name,
        { description: reg.description, inputSchema: reg.inputSchema },
        async (input, extra) => {
          const reqHeaders = extra.requestInfo?.headers ?? {}
          const ctx = session.contextFromHeaders(reqHeaders)
          try {
            const result = await reg.handler(input, ctx)
            const decorated = decorateToolResultWithAgentSources(reg.name, input, result)
            return {
              content: [{ type: 'text', text: JSON.stringify(decorated) }],
              structuredContent: toStructuredContent(decorated)
            }
          } catch (err) {
            logger.error(`Tool ${reg.name} failed`, err)
            // Single choke point for all vault-tool execution failures (every
            // backend and external MCP client routes through this server). A
            // user tapping Deny is a normal state, not a fault worth counting.
            const code = err instanceof AgentToolError ? err.code : 'INTERNAL'
            if (code !== 'PERMISSION_DENIED') {
              trackMainLog('error', {
                scope: 'AgentMcpServer',
                action: `tool_failed_${reg.name}`,
                errorCode: code
              })
            }
            return toMcpToolErrorContent(err)
          }
        }
      )
    }
    return mcp
  }

  const server = http.createServer((req, res) => {
    void handleRequest(req, res)
  })

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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

    if (req.method === 'POST' && req.url === '/mcp') {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      const mcp = createMcpServer()
      try {
        await mcp.connect(transport)
        const body = await readJson(req)
        await transport.handleRequest(req, res, body)
      } catch (err) {
        logger.error('MCP request failed', err)
        trackMainError('agent', 'mcp_request', err)
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'internal' }))
        }
      } finally {
        await mcp.close()
      }
      return
    }

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not_found' }))
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      // Lifetime handler, installed in the same tick the listen-only one is
      // removed. Without it a later server-level 'error' — accept(2) failing
      // after listen — is an unhandled EventEmitter error thrown out of Node's
      // onconnection callback, and main/index.ts's uncaughtException handler
      // absorbs it into telemetry as `main_process:uncaught_exception`: nothing
      // in the log file, and no hint the MCP endpoint was involved.
      //
      // Log and report only. An accept failure never closes the listening
      // socket, so the endpoint keeps serving; stopping it here would kill
      // Agent Chat for the rest of the vault session, because
      // startAgentMcpLifecycle() early-returns while it holds this handle and
      // nothing would rebind until the vault is switched.
      server.on('error', (err) => {
        logger.error('Agent MCP server error', err)
        trackMainError('agent', 'mcp_server', err)
      })
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
    registerTool: bindTool,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      logger.info('Agent MCP server stopped')
    }
  }
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function toStructuredContent(result: unknown): Record<string, unknown> {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return result as Record<string, unknown>
  }
  return { result }
}
