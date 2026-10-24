import { and, asc, count, desc, eq, isNull } from 'drizzle-orm'
import type {
  AgentLocalModelList,
  AgentLocalProviderProbeResult,
  AgentLocalProviderSettings
} from '@memry/contracts/ipc-agent'
import { agentConversations, agentMessages } from '@memry/db-schema/data-schema'
import type { AgentService } from './agent.ts'
import { isLoopbackBaseUrl } from './agent.ts'
import type { DataDb } from './database.ts'

export interface AgentConversationSummary {
  id: string
  backend: string
  backendModel: string | null
  pinned: boolean
  messageCount: number
  createdAt: number
  updatedAt: number
}

export interface AgentExtrasService {
  conversations(): Promise<AgentConversationSummary[]>
  conversation(id: string): Promise<AgentConversationSummary | null>
  preferences(): Promise<never>
  setPreferences(): Promise<never>
  localModels(): Promise<AgentLocalModelList>
  testLocal(): Promise<AgentLocalProviderProbeResult>
  mcpStatus(): Promise<never>
  rotateMcpToken(): Promise<never>
}

const LOCAL_REQUEST_TIMEOUT_MS = 15_000

const needsDesktop = (what: string): Error =>
  new Error(`${what} needs the Memry desktop app: it holds that state in memory or its own config.`)

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Desktop's `listOpenAiCompatibleModels`, without the keychain-held API key. */
async function listOpenAiCompatibleModels(baseUrl: string): Promise<string[]> {
  const response = await fetch(new URL('models', ensureTrailingSlash(baseUrl)), {
    signal: AbortSignal.timeout(LOCAL_REQUEST_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`/v1/models returned HTTP ${response.status}`)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- boundary value (JSON, SQL row or test double) whose shape the producer fixes
  const payload = (await response.json()) as { data?: Array<{ id?: string }> }
  return (payload.data ?? []).flatMap((model) => (model.id ? [model.id] : []))
}

function assertReachable(settings: AgentLocalProviderSettings): void {
  if (!isLoopbackBaseUrl(settings.baseUrl) && !settings.allowNonLoopback) {
    throw new Error('Non-loopback local provider endpoints require explicit confirmation.')
  }
}

export function createAgentExtrasService({
  dataDb,
  agent
}: {
  dataDb: DataDb
  agent: AgentService
}): AgentExtrasService {
  function summarize(row: typeof agentConversations.$inferSelect): AgentConversationSummary {
    const messages =
      dataDb
        .select({ total: count() })
        .from(agentMessages)
        .where(and(eq(agentMessages.conversationId, row.id), isNull(agentMessages.deletedAt)))
        .get()?.total ?? 0
    return {
      id: row.id,
      backend: row.backend,
      backendModel: row.backendModel,
      pinned: row.pinned,
      messageCount: messages,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }
  }

  return {
    // Titles and messages are encrypted with the vault key that lives in the
    // OS keychain, so only the metadata is readable here.
    async conversations() {
      return dataDb
        .select()
        .from(agentConversations)
        .where(isNull(agentConversations.deletedAt))
        .orderBy(desc(agentConversations.updatedAt), asc(agentConversations.id))
        .all()
        .map(summarize)
    },

    async conversation(id) {
      const row = dataDb
        .select()
        .from(agentConversations)
        .where(and(eq(agentConversations.id, id), isNull(agentConversations.deletedAt)))
        .get()
      return row ? summarize(row) : null
    },

    async preferences() {
      throw needsDesktop('Agent chat preferences')
    },

    async setPreferences() {
      throw needsDesktop('Changing agent chat preferences')
    },

    async localModels() {
      const settings = await agent.getLocalProviderSettings()
      assertReachable(settings)
      try {
        return { models: await listOpenAiCompatibleModels(settings.baseUrl) }
      } catch {
        // Desktop reports an unreachable provider as an empty list too.
        return { models: [] }
      }
    },

    // Desktop's `testOpenAiCompatibleConnection`: list the models, then check the chosen one is served.
    async testLocal() {
      const settings = await agent.getLocalProviderSettings()
      assertReachable(settings)
      try {
        const models = await listOpenAiCompatibleModels(settings.baseUrl)
        const modelAvailable = !settings.model || models.includes(settings.model)
        return {
          connected: true,
          modelAvailable,
          streamingSupported: true,
          toolCallingSupported: false,
          toolContinuationSupported: false,
          toolsEnabled: false,
          detail: modelAvailable ? null : `Model ${settings.model} was not returned by /v1/models.`
        }
      } catch (error) {
        return {
          connected: false,
          modelAvailable: false,
          streamingSupported: false,
          toolCallingSupported: false,
          toolContinuationSupported: false,
          toolsEnabled: false,
          detail: errorMessage(error)
        }
      }
    },

    async mcpStatus() {
      throw needsDesktop('The agent MCP server status')
    },

    async rotateMcpToken() {
      throw needsDesktop('Rotating the agent MCP token')
    }
  }
}
