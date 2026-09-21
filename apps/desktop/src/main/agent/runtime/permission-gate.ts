import type {
  AgentToolApprovalMode,
  ApproveToolDecision,
  ChangePreviewKind
} from '@memry/contracts/ipc-agent'

import {
  CREATE_TOOL_NAMES,
  READ_TOOL_NAMES,
  previewKindForTool,
  type ToolName
} from '../mcp/tools/schemas'

const READ_TOOLS: ReadonlySet<string> = new Set(READ_TOOL_NAMES)
const CREATE_TOOLS: ReadonlySet<string> = new Set(CREATE_TOOL_NAMES)

export interface GateInput {
  toolName: string
  trustList: string[]
  pendingDecision: ApproveToolDecision | null
  toolApprovalMode?: AgentToolApprovalMode
}

export type GateDecision =
  | { outcome: 'auto_approve' }
  | { outcome: 'await_user'; requiresDiff: boolean; previewKind: ChangePreviewKind }
  | { outcome: 'apply_decision'; decision: ApproveToolDecision }

function awaitUser(toolName: string): GateDecision {
  const previewKind = previewKindForTool(toolName)
  return { outcome: 'await_user', requiresDiff: previewKind !== 'none', previewKind }
}

export function decideToolGate(input: GateInput): GateDecision {
  if (input.pendingDecision) {
    return { outcome: 'apply_decision', decision: input.pendingDecision }
  }

  // Absent means "nobody has chosen", and the safe reading of that is to ask.
  // Only an explicit always_accept skips the card.
  if ((input.toolApprovalMode ?? 'ask') === 'always_accept') {
    return { outcome: 'auto_approve' }
  }

  if (READ_TOOLS.has(input.toolName)) {
    return { outcome: 'auto_approve' }
  }

  if (CREATE_TOOLS.has(input.toolName)) {
    if (input.trustList.includes(input.toolName)) {
      return { outcome: 'auto_approve' }
    }
    return awaitUser(input.toolName)
  }

  // Updates, deletes and anything unrecognised. A name the preview table has
  // not been taught about still lands on "ask", just without a preview: the
  // gate must never fall through to allowing a write it cannot describe.
  return awaitUser(input.toolName)
}

export type { ToolName }
