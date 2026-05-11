import type { ClaudeEffort } from '@memry/contracts/ipc-agent'

import { getOrInitializeLocalVaultKey, secureCleanup } from '../crypto'
import { getDatabase, getIndexDatabase } from '../database'
import {
  registerAgentHandlers,
  registerUnavailableAgentHandlers,
  unregisterAgentHandlers
} from '../ipc/agent-handlers'
import { createLogger } from '../lib/logger'
import { detectClaudeBinary } from './cli/claude-binary'
import { spawnClaudeTurn } from './cli/spawn'
import { getPublicStatus } from './mcp/lifecycle'
import { createVaultServiceHandles } from './mcp/tools/handles-adapter'
import { ALL_TOOL_NAMES } from './mcp/tools/schemas'
import { AgentRuntime } from './runtime/runtime'
import { createConversationStore } from './storage/conversation-store'
import { createMessageStore } from './storage/message-store'
import { getOrCreateVaultUuid } from './storage/vault-id'

const logger = createLogger('AgentBootstrap')
const ALLOWED_AGENT_TOOLS = ALL_TOOL_NAMES.map((name) => `mcp__memry__${name}`).join(',')

function mergeContent(
  current: string,
  mode: 'append' | 'prepend' | 'replace',
  next: string
): string {
  if (mode === 'replace') return next
  if (!current) return next
  if (!next) return current
  return mode === 'append' ? `${current}\n\n${next}` : `${next}\n\n${current}`
}

export interface AgentHandle {
  shutdown: () => Promise<void>
}

export async function startAgent(): Promise<AgentHandle> {
  const db = getDatabase()
  const vaultId = getOrCreateVaultUuid(db)
  let vaultKey: Uint8Array
  try {
    vaultKey = await getOrInitializeLocalVaultKey(db, vaultId)
  } catch (error) {
    const reason = extractErrorMessage(error, 'Vault key unavailable')
    logger.warn(`Agent runtime unavailable: ${reason}`)
    registerUnavailableAgentHandlers(reason)
    return {
      shutdown: async () => {
        unregisterAgentHandlers()
      }
    }
  }

  const indexDb = getIndexDatabase()
  const deviceId = process.env.MEMRY_DEVICE ?? 'desktop'
  const conversations = createConversationStore({ db, vaultKey, deviceId })
  const messages = createMessageStore({ db, vaultKey, deviceId })
  const handles = createVaultServiceHandles({ dataDb: db, indexDb })

  const spawnAdapter = async ({
    prompt,
    conversationId,
    windowId,
    effort,
    purpose = 'turn'
  }: {
    prompt: string
    conversationId: string
    windowId: string
    effort: ClaudeEffort
    purpose?: 'turn' | 'summary' | 'title'
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
      allowedTools: purpose === 'title' ? '' : ALLOWED_AGENT_TOOLS,
      effort,
      prompt
    })

    const stdout = sub.proc.stdout
    const stderr = sub.proc.stderr
    if (!stdout || !stderr) {
      throw new Error('Claude subprocess stdio unavailable')
    }
    const exitCodePromise = new Promise<number>((resolve) => {
      sub.proc.once('exit', (code) => resolve(code ?? 0))
    })

    return {
      stdout,
      stderr,
      pid: sub.pid,
      kill: () => sub.proc.kill('SIGTERM'),
      waitExit: () => exitCodePromise,
      cleanup: sub.cleanup
    }
  }

  const runtime = new AgentRuntime({ conversations, messages, spawn: spawnAdapter })
  runtime.install()

  registerAgentHandlers({
    runtime,
    conversations,
    messages,
    previewNoteUpdate: async (input) => {
      const note = await handles.notes.read(input.id)
      if (!note) throw new Error(`Note not found: ${input.id}`)
      return {
        title: note.title,
        current: note.content_markdown,
        candidate: mergeContent(note.content_markdown, input.mode, input.content_markdown)
      }
    },
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

function extractErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}
