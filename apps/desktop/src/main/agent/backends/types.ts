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
import type { TurnWriteGrant } from '../turn-grants'

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

/**
 * A real turn, as opposed to the title and summary runs that share the shape.
 * Only a turn may write to the vault, so only a turn carries the capability —
 * the compiler, not a runtime check, is what keeps the two apart.
 */
export interface AgentBackendTurnInput extends AgentBackendRunInput {
  writeGrant: TurnWriteGrant
}

export interface AgentBackend {
  id: AgentBackendId
  runTurn(input: AgentBackendTurnInput): Promise<BackendRunHandle>
  generateTitle(input: AgentBackendRunInput): Promise<BackendRunHandle>
  summarize(input: AgentBackendRunInput): Promise<BackendRunHandle>
  getStatus(): Promise<AgentBackendStatus>
  probeCapabilities?(): Promise<AgentLocalProviderProbeResult>
}

export interface ClaudeCliSpawnInput {
  prompt: string
  writeGrant?: TurnWriteGrant
  windowId: string
  effort: ClaudeEffort
  model?: string
  permissions?: AgentTurnPermissions
  purpose?: 'turn' | 'summary' | 'title'
}

export interface CodexCliSpawnInput {
  prompt: string
  writeGrant?: TurnWriteGrant
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
