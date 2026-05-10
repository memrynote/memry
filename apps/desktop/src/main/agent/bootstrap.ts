import { getOrDeriveVaultKey, secureCleanup } from '../crypto'
import { getDatabase } from '../database'
import { registerAgentHandlers, unregisterAgentHandlers } from '../ipc/agent-handlers'
import { createLogger } from '../lib/logger'
import { detectClaudeBinary } from './cli/claude-binary'
import { spawnClaudeTurn } from './cli/spawn'
import { getPublicStatus } from './mcp/lifecycle'
import { ALL_TOOL_NAMES } from './mcp/tools/schemas'
import { AgentRuntime } from './runtime/runtime'
import { createConversationStore } from './storage/conversation-store'
import { createMessageStore } from './storage/message-store'
import { getOrCreateVaultUuid } from './storage/vault-id'

const logger = createLogger('AgentBootstrap')
const ALLOWED_AGENT_TOOLS = ALL_TOOL_NAMES.map((name) => `mcp__memry__${name}`).join(',')

export interface AgentHandle {
  shutdown: () => Promise<void>
}

export async function startAgent(): Promise<AgentHandle> {
  const db = getDatabase()
  const vaultKey = await getOrDeriveVaultKey()
  const deviceId = process.env.MEMRY_DEVICE ?? 'desktop'
  const vaultId = getOrCreateVaultUuid(db)
  const conversations = createConversationStore({ db, vaultKey, deviceId })
  const messages = createMessageStore({ db, vaultKey, deviceId })

  const spawnAdapter = async ({
    prompt,
    conversationId,
    windowId
  }: {
    prompt: string
    conversationId: string
    windowId: string
  }) => {
    const binary = await detectClaudeBinary()
    if (!binary.detected || !binary.meetsMinimum) {
      throw new Error(binary.installHint ?? 'Claude CLI unavailable')
    }

    const status = getPublicStatus()
    if (!status.url || !status['token']) {
      throw new Error('Agent MCP server not running')
    }

    const sub = await spawnClaudeTurn({
      binaryPath: 'claude',
      mcpServerUrl: status.url,
      authorizationValue: status['token'],
      conversationId,
      windowId,
      allowedTools: ALLOWED_AGENT_TOOLS,
      prompt
    })

    const stdout = sub.proc.stdout
    const stderr = sub.proc.stderr
    if (!stdout || !stderr) {
      throw new Error('Claude subprocess stdio unavailable')
    }

    return {
      stdout,
      stderr,
      pid: sub.pid,
      kill: () => sub.proc.kill('SIGTERM'),
      waitExit: () =>
        new Promise<number>((resolve) => {
          sub.proc.once('exit', (code) => resolve(code ?? 0))
        }),
      cleanup: sub.cleanup
    }
  }

  const runtime = new AgentRuntime({ conversations, messages, spawn: spawnAdapter })
  runtime.install()

  registerAgentHandlers({
    runtime,
    conversations,
    messages,
    spawn: spawnAdapter,
    routeToolCall: async () => ({ ok: true, data: null }),
    vaultId
  })

  logger.info(`Agent runtime ready for vault ${vaultId}`)

  return {
    shutdown: async () => {
      unregisterAgentHandlers()
      await runtime.killAll()
      secureCleanup(vaultKey)
    }
  }
}
