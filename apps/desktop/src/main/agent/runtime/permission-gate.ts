import {
  isInPageReviewTool,
  type AgentReviewTarget,
  type AgentToolApprovalMode,
  type ApproveToolDecision,
  type ChangePreviewKind
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

  // A rewrite of the user's own note or journal is reviewed in the page every
  // time. Grants recorded before this rule existed stay on disk and in
  // Settings, but no longer skip the review.
  if (isInPageReviewTool(input.toolName)) {
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

/**
 * Which page reviews this write in place, or null when the agent pane keeps the
 * approval card. A journal update that carries no body (tags or properties
 * only) has nothing to show in the page, so it stays in the pane.
 */
export function reviewTargetForTool(toolName: string, args: unknown): AgentReviewTarget | null {
  if (!isInPageReviewTool(toolName)) return null
  const record =
    args && typeof args === 'object' && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {}
  if (toolName === 'vault_update_note' && typeof record.id === 'string') {
    return { kind: 'note', id: record.id }
  }
  if (
    toolName === 'vault_update_journal_entry' &&
    typeof record.date === 'string' &&
    typeof record.content_markdown === 'string'
  ) {
    return { kind: 'journal', date: record.date }
  }
  return null
}

export type { ToolName }
