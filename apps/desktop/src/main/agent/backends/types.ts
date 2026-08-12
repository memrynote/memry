import type {
  AgentBackendId,
  AgentBackendOptions,
  AgentBackendStatus,
  AgentLocalProviderProbeResult,
  AgentTurnPermissions,
  ClaudeEffort,
  CodexReasoningEffort
} from '@memry/contracts/ipc-agent'

import type { BackendEvent } from '../cli/types'

export interface BackendRunHandle {
  events: AsyncIterable<BackendEvent>
  stderr?: AsyncIterable<Buffer | string>
  pid: number
  kill: () => void
  waitExit: () => Promise<number>
  cleanup: () => Promise<void>
}

export interface AgentBackendRunInput {
  prompt: string
  conversationId: string
  windowId: string
  options: AgentBackendOptions
  permissions?: AgentTurnPermissions
  purpose?: 'turn' | 'summary' | 'title'
}

export interface AgentBackend {
  id: AgentBackendId
  runTurn(input: AgentBackendRunInput): Promise<BackendRunHandle>
  generateTitle(input: AgentBackendRunInput): Promise<BackendRunHandle>
  summarize(input: AgentBackendRunInput): Promise<BackendRunHandle>
  getStatus(): Promise<AgentBackendStatus>
  probeCapabilities?(): Promise<AgentLocalProviderProbeResult>
}

export interface ClaudeCliSpawnInput {
  prompt: string
  conversationId: string
  windowId: string
  effort: ClaudeEffort
  model?: string
  permissions?: AgentTurnPermissions
  purpose?: 'turn' | 'summary' | 'title'
}

export interface CodexCliSpawnInput {
  prompt: string
  conversationId: string
  windowId: string
  reasoningEffort: CodexReasoningEffort
  model?: string
  permissions?: AgentTurnPermissions
  purpose?: 'turn' | 'summary' | 'title'
}

export interface RawSubprocessHandle {
  stdout: AsyncIterable<Buffer>
  stderr: AsyncIterable<Buffer>
  pid: number
  kill: () => void
  waitExit: () => Promise<number>
  cleanup: () => Promise<void>
}
