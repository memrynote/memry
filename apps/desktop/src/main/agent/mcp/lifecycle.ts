import { getDatabase, getIndexDatabase } from '../../database'
import { createLogger } from '../../lib/logger'
import { startAgentMcpServer, type AgentMcpServerHandle } from './server'
import { buildReadTools } from './tools/read-tools'
import { createVaultServiceHandles } from './tools/handles-adapter'
import { buildWriteTools, type WriteToolGate } from './tools/write-tools'

const logger = createLogger('AgentMcp:Lifecycle')

let handle: AgentMcpServerHandle | null = null
let writeGate: WriteToolGate | null = null
let toolCount = 0

export interface PublicStatus {
  url: string | null
  ['token']: string | null
  toolCount: number
}

export async function startAgentMcpLifecycle(): Promise<void> {
  if (handle) return

  const handles = createVaultServiceHandles({
    dataDb: getDatabase(),
    indexDb: getIndexDatabase()
  })
  const tools = [...buildReadTools(handles), ...buildWriteTools(handles, writeGate)]

  handle = await startAgentMcpServer({ toolRegistrations: tools })
  toolCount = tools.length
  logger.info(`Agent MCP lifecycle started; ${tools.length} tools registered`)
}

export async function stopAgentMcpLifecycle(): Promise<void> {
  if (!handle) return

  await handle.stop()
  handle = null
  toolCount = 0
}

export function getPublicStatus(): PublicStatus {
  if (!handle) return { url: null, ['token']: null, toolCount: 0 }
  return { url: handle.url, ['token']: handle.token, toolCount }
}

export function rotateToken(): string {
  if (!handle) throw new Error('Agent MCP server not running')
  return handle.rotateToken()
}

export function setWriteGate(gate: WriteToolGate | null): void {
  writeGate = gate
  if (!handle) return

  const handles = createVaultServiceHandles({
    dataDb: getDatabase(),
    indexDb: getIndexDatabase()
  })

  for (const tool of buildWriteTools(handles, writeGate)) {
    handle.registerTool(tool)
  }
}
