import type { ApproveToolDecision } from '@memry/contracts/ipc-agent'

import { createLogger } from '../../lib/logger'
import { setWriteGate as setMcpWriteGate } from '../mcp/lifecycle'
import type { ConversationStore } from '../storage/conversation-store'
import type { MessageStore } from '../storage/message-store'
import { broadcastAgentEvent } from './event-bus'
import { decideToolGate } from './permission-gate'

const logger = createLogger('AgentRuntime')

interface PendingApproval {
  resolve: (decision: ApproveToolDecision) => void
  conversationId: string
  toolCallId: string
  name: string
  args: unknown
  requiresDiff: boolean
}

export interface AgentRuntimeDeps {
  conversations: ConversationStore
  messages: MessageStore
  spawn: (input: { prompt: string; conversationId: string; windowId: string }) => Promise<{
    stdout: AsyncIterable<Buffer>
    stderr: AsyncIterable<Buffer>
    pid: number
    kill: () => void
    waitExit: () => Promise<number>
    cleanup: () => Promise<void>
  }>
}

export type PendingApprovalSnapshot = Omit<PendingApproval, 'resolve'>

export class AgentRuntime {
  private inFlight = new Map<string, AbortController>()
  private pending = new Map<string, PendingApproval>()
  private subprocesses = new Set<{ pid: number; kill: () => void }>()

  constructor(private deps: AgentRuntimeDeps) {}

  install(): void {
    setMcpWriteGate(async (ctx) => {
      const conversation = await this.deps.conversations.getById(ctx.conversationId)
      if (!conversation) {
        return { approved: false, reason: 'Unknown conversation' }
      }

      const decision = decideToolGate({
        toolName: ctx.toolName,
        trustList: conversation.trustList,
        pendingDecision: null
      })
      if (decision.outcome === 'auto_approve') {
        return { approved: true }
      }

      const toolCallId = `gate-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const requiresDiff = decision.outcome === 'await_user' ? decision.requiresDiff : false
      broadcastAgentEvent({
        kind: 'tool_call_pending_approval',
        conversationId: ctx.conversationId,
        toolCallId,
        name: ctx.toolName,
        args: ctx.parsedArgs,
        requiresDiff
      })

      const userDecision = await this.waitForApproval({
        conversationId: ctx.conversationId,
        toolCallId,
        name: ctx.toolName,
        args: ctx.parsedArgs,
        requiresDiff
      })
      if (userDecision.kind === 'deny') {
        return { approved: false, reason: 'User denied request.' }
      }

      if (userDecision.kind === 'allow_always') {
        await this.deps.conversations.addToTrustList(ctx.conversationId, ctx.toolName)
      }

      const args = userDecision.kind === 'edit_allow' ? userDecision.editedArgs : ctx.parsedArgs
      return { approved: true, args }
    })
  }

  resolveApproval(toolCallId: string, decision: ApproveToolDecision): void {
    const pending = this.pending.get(toolCallId)
    if (!pending) {
      logger.warn(`Stale approval for ${toolCallId}`)
      return
    }

    pending.resolve(decision)
    this.pending.delete(toolCallId)
  }

  getPendingApproval(toolCallId: string): PendingApprovalSnapshot | null {
    const pending = this.pending.get(toolCallId)
    if (!pending) return null
    return {
      conversationId: pending.conversationId,
      toolCallId: pending.toolCallId,
      name: pending.name,
      args: pending.args,
      requiresDiff: pending.requiresDiff
    }
  }

  cancelTurn(conversationId: string): void {
    this.inFlight.get(conversationId)?.abort()
  }

  async killAll(): Promise<void> {
    for (const sub of this.subprocesses) {
      try {
        sub.kill()
      } catch (error) {
        logger.warn('Failed to kill subprocess', error)
      }
    }
    this.subprocesses.clear()

    for (const controller of this.inFlight.values()) {
      controller.abort()
    }
    this.inFlight.clear()
  }

  private waitForApproval(input: PendingApprovalSnapshot): Promise<ApproveToolDecision> {
    return new Promise((resolve) => {
      this.pending.set(input.toolCallId, { ...input, resolve })
    })
  }
}
