import type { AgentToolApprovalMode, ApproveToolDecision } from '@memry/contracts/ipc-agent'

import {
  CREATE_TOOL_NAMES,
  READ_TOOL_NAMES,
  UPDATE_TOOL_NAMES,
  type ToolName
} from '../mcp/tools/schemas'

const READ_TOOLS: ReadonlySet<string> = new Set(READ_TOOL_NAMES)
const CREATE_TOOLS: ReadonlySet<string> = new Set(CREATE_TOOL_NAMES)
const UPDATE_TOOLS: ReadonlySet<string> = new Set(UPDATE_TOOL_NAMES)

export interface GateInput {
  toolName: string
  trustList: string[]
  pendingDecision: ApproveToolDecision | null
  toolApprovalMode?: AgentToolApprovalMode
}

export type GateDecision =
  | { outcome: 'auto_approve' }
  | { outcome: 'await_user'; requiresDiff: boolean }
  | { outcome: 'apply_decision'; decision: ApproveToolDecision }

export function decideToolGate(input: GateInput): GateDecision {
  if (input.pendingDecision) {
    return { outcome: 'apply_decision', decision: input.pendingDecision }
  }

  if ((input.toolApprovalMode ?? 'always_accept') === 'always_accept') {
    return { outcome: 'auto_approve' }
  }

  if (READ_TOOLS.has(input.toolName)) {
    return { outcome: 'auto_approve' }
  }

  if (CREATE_TOOLS.has(input.toolName)) {
    if (input.trustList.includes(input.toolName)) {
      return { outcome: 'auto_approve' }
    }
    return { outcome: 'await_user', requiresDiff: false }
  }

  if (UPDATE_TOOLS.has(input.toolName)) {
    return { outcome: 'await_user', requiresDiff: input.toolName === 'vault_update_note' }
  }

  return { outcome: 'await_user', requiresDiff: false }
}

export type { ToolName }
