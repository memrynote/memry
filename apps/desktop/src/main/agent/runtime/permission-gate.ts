import type {
  AgentToolApprovalMode,
  ApproveToolDecision,
  ChangePreviewKind
} from '@memry/contracts/ipc-agent'

import { READ_TOOL_NAMES, previewKindForTool, type ToolName } from '../mcp/tools/schemas'

const READ_TOOLS: ReadonlySet<string> = new Set(READ_TOOL_NAMES)

export interface GateInput {
  toolName: string
  /** Standing approvals that die with this conversation. */
  trustList: string[]
  /** Standing approvals that outlive it, revocable in Settings. */
  vaultTrustList?: string[]
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

  // A delete is never trustable, at either scope. "Always allow" is a promise
  // about work the user can look at afterwards; a delete is the one write where
  // that is not true, so it asks every time and the menu says so out loud.
  if (previewKindForTool(input.toolName) === 'loss') {
    return awaitUser(input.toolName)
  }

  const trusted =
    input.trustList.includes(input.toolName) ||
    (input.vaultTrustList ?? []).includes(input.toolName)
  if (trusted) {
    return { outcome: 'auto_approve' }
  }

  // Creates, updates and anything unrecognised. A name the preview table has
  // not been taught about still lands on "ask", just without a preview: the
  // gate must never fall through to allowing a write it cannot describe.
  return awaitUser(input.toolName)
}

export type { ToolName }
