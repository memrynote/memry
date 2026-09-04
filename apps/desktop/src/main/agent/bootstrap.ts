import { EVENT_CHANNELS } from '@memry/contracts/ipc-events'

import { getOrInitializeLocalVaultKey, secureCleanup } from '../crypto'
import { classifyVaultKeyError, vaultRecoveryReason } from '../crypto/vault-key-error'
import { getDatabase, getIndexDatabase } from '../database'
import { registerAgentHandlers, unregisterAgentHandlers } from '../ipc/agent-handlers'
import { createLogger } from '../lib/logger'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { markExpectedCondition } from '../telemetry/expected-conditions'
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
import {
  createEphemeralConversationStore,
  createEphemeralMessageStore
} from './storage/ephemeral-stores'
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

/**
 * The vault key, or `null` when this device cannot produce it.
 *
 * Failing to resolve it is routine rather than exceptional: a vault folder
 * opened on a second machine carries a verifier that machine's keychain never
 * wrote, and an OS keychain can refuse the read outright. Both are reported, and
 * a recoverable mismatch still raises the recovery prompt — but neither is
 * allowed to take Agent Chat down, because nothing except the transcript needs
 * the key.
 */
async function resolveVaultKeyForAgent(
  db: ReturnType<typeof getDatabase>,
  vaultId: string
): Promise<Uint8Array | null> {
  try {
    return await getOrInitializeLocalVaultKey(db, vaultId)
  } catch (error) {
    const reason = extractErrorMessage(error, 'Vault key unavailable')
    logger.warn(`Agent transcript will not be saved this session: ${reason}`)
    trackMainError('agent', 'bootstrap_vault_key', error)
    // Agent Chat can be the only subsystem that touches the vault key in a
    // session (sync paused, or never started), so it has to raise the recovery
    // event the sync runtime raises — otherwise the dialog never opens and the
    // user is left guessing.
    if (classifyVaultKeyError(error) === 'recovery-needed') {
      broadcastToAllWindows(EVENT_CHANNELS.VAULT_RECOVERY_NEEDED, {
        reason: vaultRecoveryReason(error)
      })
    }
    return null
  }
}

export async function startAgent(): Promise<AgentHandle> {
  const db = getDatabase()
  const vaultId = getOrCreateVaultUuid(db)
  const vaultKey = await resolveVaultKeyForAgent(db, vaultId)

  const indexDb = getIndexDatabase()
  const deviceId = process.env.MEMRY_DEVICE ?? 'desktop'
  // Only the transcript is bound to the vault key. When it cannot be resolved
  // the runtime still starts — against stores that keep the session in memory
  // rather than writing rows nothing will ever decrypt. See ephemeral-stores.ts.
  const historyPersisted = vaultKey !== null
  const conversations = vaultKey
    ? createConversationStore({ db, vaultKey, deviceId })
    : createEphemeralConversationStore(deviceId)
  const messages = vaultKey
    ? createMessageStore({ db, vaultKey, deviceId })
    : createEphemeralMessageStore(deviceId)
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
      throw markExpectedCondition(new Error(binary.installHint ?? 'Claude CLI unavailable'))
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
      throw markExpectedCondition(new Error(binary.installHint ?? 'Codex CLI unavailable'))
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
    historyPersisted,
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
      if (vaultKey) secureCleanup(vaultKey)
    }
  }
}

function extractErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}
