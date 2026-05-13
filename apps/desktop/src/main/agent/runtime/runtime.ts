import type { AgentPreferences, ApproveToolDecision } from '@memry/contracts/ipc-agent'

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

interface TrackedSubprocess {
  conversationId: string
  pid: number
  kill: () => void
}

export interface AgentRuntimeDeps {
  conversations: ConversationStore
  messages: MessageStore
  getPreferences?: () => AgentPreferences
}

export type PendingApprovalSnapshot = Omit<PendingApproval, 'resolve'>

export class AgentRuntime {
  private inFlight = new Map<string, AbortController>()
  private pending = new Map<string, PendingApproval>()
  private subprocesses = new Map<number, TrackedSubprocess>()
  private turnLocks = new Set<string>()

  constructor(private deps: AgentRuntimeDeps) {}

  install(): void {
    setMcpWriteGate(async (ctx) => {
      const conversation = this.deps.conversations.getById(ctx.conversationId)
      if (!conversation) {
        return { approved: false, reason: 'Unknown conversation' }
      }

      const decision = decideToolGate({
        toolName: ctx.toolName,
        trustList: conversation.trustList,
        pendingDecision: null,
        toolApprovalMode: this.deps.getPreferences?.().toolApprovalMode
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
        this.deps.conversations.addToTrustList(ctx.conversationId, ctx.toolName)
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
    for (const sub of this.subprocesses.values()) {
      if (sub.conversationId !== conversationId) continue
      try {
        sub.kill()
      } catch (error) {
        logger.warn('Failed to kill subprocess', error)
      }
    }
  }

  acquireTurnLock(conversationId: string): void {
    if (this.turnLocks.has(conversationId)) {
      throw new Error(
        `There is already a turn in flight for conversation ${conversationId}; another window may be mid-turn.`
      )
    }
    this.turnLocks.add(conversationId)
  }

  releaseTurnLock(conversationId: string): void {
    this.turnLocks.delete(conversationId)
  }

  trackSubprocess(
    conversationId: string,
    subprocess: {
      pid: number
      kill: () => void
    }
  ): void {
    this.subprocesses.set(subprocess.pid, {
      conversationId,
      pid: subprocess.pid,
      kill: subprocess.kill
    })
  }

  untrackSubprocess(pid: number): void {
    this.subprocesses.delete(pid)
  }

  async killAll(): Promise<void> {
    for (const sub of this.subprocesses.values()) {
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
    this.turnLocks.clear()
  }

  private waitForApproval(input: PendingApprovalSnapshot): Promise<ApproveToolDecision> {
    return new Promise((resolve) => {
      this.pending.set(input.toolCallId, { ...input, resolve })
    })
  }
}
