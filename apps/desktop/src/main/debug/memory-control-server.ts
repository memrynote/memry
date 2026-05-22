import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  MEMORY_DEBUG_DEFAULT_PORT,
  MEMORY_DEBUG_HOST,
  type MemorySnapshotRequest,
  type MemoryScenario
} from './memory-snapshot-types'
import { createLogger } from '../lib/logger'
import { getStatus, switchVault } from '../vault'
import { captureDebugMemorySnapshot, isMemoryDebugEnabled } from './memory-snapshot'

const log = createLogger('MemoryControl')
const validScenarios = new Set<MemoryScenario>(['boot', 'idle-60s'])

let server: Server | null = null

function getPort(): number {
  const port = Number(process.env.MEMRY_DEBUG_MEMORY_PORT ?? MEMORY_DEBUG_DEFAULT_PORT)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : MEMORY_DEBUG_DEFAULT_PORT
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  response.end(`${JSON.stringify(payload)}\n`)
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'))
}

function parseSnapshotRequest(payload: unknown): MemorySnapshotRequest {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Snapshot request body must be an object')
  }

  const candidate = payload as Record<string, unknown>
  if (!validScenarios.has(candidate.scenario as MemoryScenario)) {
    throw new Error('scenario must be boot or idle-60s')
  }
  if (typeof candidate.label !== 'string' || candidate.label.length === 0) {
    throw new Error('label is required')
  }
  if (typeof candidate.branch !== 'string' || candidate.branch.length === 0) {
    throw new Error('branch is required')
  }

  return {
    scenario: candidate.scenario as MemoryScenario,
    label: candidate.label,
    branch: candidate.branch
  }
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${MEMORY_DEBUG_HOST}`)

  if (request.method === 'GET' && url.pathname === '/vault/status') {
    sendJson(response, 200, { vaultPath: getStatus().path ?? null })
    return
  }

  if (request.method === 'POST' && url.pathname === '/vault/open') {
    const payload = await readBody(request)
    const vaultPath =
      payload && typeof payload === 'object' ? (payload as { vaultPath?: unknown }).vaultPath : null

    if (typeof vaultPath !== 'string' || vaultPath.length === 0) {
      throw new Error('vaultPath is required')
    }

    const result = await switchVault(vaultPath)
    if (!result.success) {
      throw new Error(result.error ?? `Failed to open vault: ${vaultPath}`)
    }

    sendJson(response, 200, { vaultPath: getStatus().path ?? result.vault?.path ?? null })
    return
  }

  if (request.method === 'POST' && url.pathname === '/memory/snapshot') {
    const snapshotRequest = parseSnapshotRequest(await readBody(request))
    const snapshot = await captureDebugMemorySnapshot(snapshotRequest)
    sendJson(response, 200, snapshot)
    return
  }

  sendJson(response, 404, { error: 'Not found' })
}

export function startMemoryControlServer(): void {
  if (!isMemoryDebugEnabled() || server) return

  server = createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      const message = error instanceof Error ? error.message : 'Memory control request failed'
      sendJson(response, 400, { error: message })
    })
  })

  server.on('error', (error) => {
    log.error('memory control server failed', error)
  })

  server.listen(getPort(), MEMORY_DEBUG_HOST, () => {
    const address = server?.address()
    const port = typeof address === 'object' && address ? address.port : getPort()
    log.info(`memory control server listening on ${MEMORY_DEBUG_HOST}:${port}`)
  })
}

export async function stopMemoryControlServer(): Promise<void> {
  if (!server) return

  const activeServer = server
  server = null

  await new Promise<void>((resolve, reject) => {
    activeServer.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}
