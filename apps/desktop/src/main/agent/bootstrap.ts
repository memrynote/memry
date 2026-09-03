import { EVENT_CHANNELS } from '@memry/contracts/ipc-events'

import { getOrInitializeLocalVaultKey, secureCleanup } from '../crypto'
import { classifyVaultKeyError, vaultRecoveryReason } from '../crypto/vault-key-error'
import { getDatabase, getIndexDatabase } from '../database'
import {
  registerAgentHandlers,
  registerUnavailableAgentHandlers,
  unregisterAgentHandlers
} from '../ipc/agent-handlers'
import { createLogger } from '../lib/logger'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { trackMainError, trackMainLog } from '../telemetry/diagnostics'
import { ClaudeCliBackend } from './backends/claude-cli-backend'
import { CodexCliBackend } from './backends/codex-cli-backend'
import { getLocalProviderApiKey } from './backends/local-provider-keychain'
import {
  getLocalProviderSettings,
  setLocalProviderSettings
} from './backends/local-provider-settings'
import {
  listOpenAiCompatibleModels,
  LocalOpenAICompatibleBackend,
  testOpenAiCompatibleConnection
} from './backends/local-openai-compatible-backend'
import { createAgentBackendRegistry } from './backends/registry'
import { AgentToolBridge } from './backends/tool-bridge'
import type { ClaudeCliSpawnInput, CodexCliSpawnInput } from './backends/types'
import { detectClaudeBinary } from './cli/claude-binary'
import { detectCodexBinary } from './cli/codex-binary'
import { spawnCodexTurn } from './cli/codex-spawn'
import { createEscalatingKill } from './cli/kill'
import { spawnClaudeTurn } from './cli/spawn'
import { getPublicStatus } from './mcp/lifecycle'
import { createVaultServiceHandles } from './mcp/tools/handles-adapter'
import { ALL_TOOL_NAMES } from './mcp/tools/schemas'
import { AgentRuntime } from './runtime/runtime'
import { getAgentPreferences, setAgentPreferences } from './settings'
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
    // The whole Agent Chat feature is disabled for this session — a fully
    // user-facing failure (every agent invoke errors), so it must be countable.
    trackMainError('agent', 'bootstrap_vault_key', error)
    // Agent Chat can be the only subsystem that touches the vault key in a
    // session (sync paused, or never started), and until now it swallowed a
    // recoverable key mismatch into a log line — the UI then blamed the CLIs
    // ("not detected") and the user never saw the recovery prompt. Raise the
    // same event the sync runtime raises so the recovery dialog opens.
    if (classifyVaultKeyError(error) === 'recovery-needed') {
      broadcastToAllWindows(EVENT_CHANNELS.VAULT_RECOVERY_NEEDED, {
        reason: vaultRecoveryReason(error)
      })
    }
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

  const spawnClaudeAdapter = async ({
    prompt,
    conversationId,
    windowId,
    effort,
    model,
    permissions,
    purpose = 'turn'
  }: ClaudeCliSpawnInput) => {
    const binary = await detectClaudeBinary()
    if (!binary.detected || !binary.meetsMinimum) {
      throw new Error(binary.installHint ?? 'Claude CLI unavailable')
    }

    const status = purpose === 'turn' ? getPublicStatus() : null
    if (purpose === 'turn' && (!status?.url || !status['token'])) {
      throw new Error('Agent MCP server not running')
    }

    const sub = await spawnClaudeTurn({
      binaryPath: 'claude',
      ...(status?.url && status['token']
        ? {
            mcp: {
              serverUrl: status.url,
              authorizationValue: status['token'],
              conversationId,
              windowId,
              allowedTools: ALLOWED_AGENT_TOOLS
            }
          }
        : {}),
      effort,
      model,
      ...(permissions ? { permissions } : {}),
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
      kill: createEscalatingKill(sub.proc),
      waitExit: () => exitCodePromise,
      cleanup: sub.cleanup
    }
  }

  const spawnCodexAdapter = async ({
    prompt,
    conversationId,
    windowId,
    reasoningEffort,
    model,
    permissions,
    purpose = 'turn'
  }: CodexCliSpawnInput) => {
    const binary = await detectCodexBinary()
    if (!binary.detected || !binary.meetsMinimum) {
      throw new Error(binary.installHint ?? 'Codex CLI unavailable')
    }

    const status = purpose === 'turn' ? getPublicStatus() : null
    if (purpose === 'turn' && (!status?.url || !status['token'])) {
      throw new Error('Agent MCP server not running')
    }

    const sub = await spawnCodexTurn({
      binaryPath: 'codex',
      prompt,
      reasoningEffort,
      model,
      ...(permissions ? { permissions } : {}),
      ...(status?.url && status['token']
        ? {
            mcp: {
              serverUrl: status.url,
              authorizationValue: status['token'],
              conversationId,
              windowId
            }
          }
        : {})
    })

    const stdout = sub.proc.stdout
    const stderr = sub.proc.stderr
    if (!stdout || !stderr) {
      throw new Error('Codex subprocess stdio unavailable')
    }
    const exitCodePromise = new Promise<number>((resolve) => {
      sub.proc.once('exit', (code) => resolve(code ?? 0))
    })

    return {
      stdout,
      stderr,
      pid: sub.pid,
      kill: createEscalatingKill(sub.proc),
      waitExit: () => exitCodePromise,
      cleanup: sub.cleanup
    }
  }

  const toolBridge = new AgentToolBridge()
  const localBackend = new LocalOpenAICompatibleBackend({
    getSettings: getLocalProviderSettings,
    getApiKey: getLocalProviderApiKey,
    toolBridge
  })
  const backends = createAgentBackendRegistry({
    claude: new ClaudeCliBackend({ spawn: spawnClaudeAdapter }),
    codex: new CodexCliBackend({ spawn: spawnCodexAdapter }),
    local: localBackend
  })

  const runtime = new AgentRuntime({ conversations, messages, getPreferences: getAgentPreferences })
  runtime.install()

  registerAgentHandlers({
    runtime,
    conversations,
    messages,
    backends,
    previewNoteUpdate: async (input) => {
      const note = await handles.notes.read(input.id)
      if (!note) throw new Error(`Note not found: ${input.id}`)
      return {
        title: note.title,
        current: note.content_markdown,
        candidate: mergeContent(note.content_markdown, input.mode, input.content_markdown)
      }
    },
    localProvider: {
      getSettings: getLocalProviderSettings,
      setSettings: setLocalProviderSettings,
      listModels: async () => {
        const settings = await getLocalProviderSettings()
        try {
          return {
            models: await listOpenAiCompatibleModels(
              settings.baseUrl,
              fetch,
              await getLocalProviderApiKey()
            )
          }
        } catch (error) {
          logger.warn(
            `Local provider model listing failed: ${extractErrorMessage(error, 'unknown')}`
          )
          trackMainLog('warn', {
            scope: 'AgentBootstrap',
            action: 'local_models_list_failed',
            errorCode: 'LOCAL_PROVIDER_UNREACHABLE'
          })
          return { models: [] }
        }
      },
      testConnection: async () => {
        const settings = await getLocalProviderSettings()
        return testOpenAiCompatibleConnection(settings, fetch, await getLocalProviderApiKey())
      },
      probeTools: () => localBackend.probeCapabilities()
    },
    preferences: {
      get: getAgentPreferences,
      set: setAgentPreferences
    },
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
