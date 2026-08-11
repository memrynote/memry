import type { AgentPreferences, ApproveToolDecision } from '@memry/contracts/ipc-agent'
import { toSafeToken } from '@memry/contracts/telemetry-api'

import { createLogger } from '../../lib/logger'
import { trackMainEvent } from '../../telemetry/track'
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
  waitExit: () => Promise<number>
}

// How long shutdown waits for a killed CLI to actually be gone. Covers the 900ms
// of SIGTERM grace in createEscalatingKill plus ~300ms for the SIGKILL to land and
// 'exit' to propagate. Sized against main's 5000ms force-exit budget: flushAllWindows
// alone can claim 2000ms of it, and killAll runs at the tail of the shutdown chain
// (closeVault -> stopVaultAgentServices), so waiting longer here would trade a leak
// for a hang and lose the escalation entirely when main exits first.
const KILL_REAP_BUDGET_MS = 1200

export interface AgentRuntimeDeps {
  conversations: ConversationStore
  messages: MessageStore
  getPreferences?: () => AgentPreferences
}

export type PendingApprovalSnapshot = Omit<PendingApproval, 'resolve'>

function trackApprovalDecided(decision: string, result: 'success' | 'failed'): void {
  trackMainEvent('ai_action_completed', {
    surface: 'ai',
    action: 'tool_approval_decided',
    result,
    dimensions: { decision: toSafeToken(decision, 'unknown') }
  })
}

export class AgentRuntime {
  private inFlight = new Map<string, AbortController>()
  private pending = new Map<string, PendingApproval>()
  private subprocesses = new Map<number, TrackedSubprocess>()
  private turnLocks = new Set<string>()
  private activeTurns = new Map<string, Set<Promise<unknown>>>()
  private isShuttingDown = false

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
        trackApprovalDecided('auto', 'success')
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
      // Tool name only, never args.
      trackMainEvent('ai_action_completed', {
        surface: 'ai',
        action: 'tool_approval_requested',
        result: 'success',
        dimensions: { tool: toSafeToken(ctx.toolName, 'unknown_tool') }
      })

      const userDecision = await this.waitForApproval({
        conversationId: ctx.conversationId,
        toolCallId,
        name: ctx.toolName,
        args: ctx.parsedArgs,
        requiresDiff
      })
      // Shutdown resolves every pending approval as deny; label that
      // abandonment distinctly so the funnel separates it from a real "No".
      trackApprovalDecided(
        this.isShuttingDown && userDecision.kind === 'deny' ? 'abandoned' : userDecision.kind,
        userDecision.kind === 'deny' ? 'failed' : 'success'
      )
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
    this.denyPendingApprovals(conversationId)
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

  trackTurn(conversationId: string, turn: Promise<unknown>): void {
    let turns = this.activeTurns.get(conversationId)
    if (!turns) {
      turns = new Set()
      this.activeTurns.set(conversationId, turns)
    }
    turns.add(turn)

    void turn
      .finally(() => {
        turns.delete(turn)
        if (turns.size === 0) this.activeTurns.delete(conversationId)
      })
      .catch(() => {})
  }

  trackSubprocess(
    conversationId: string,
    subprocess: {
      pid: number
      kill: () => void
      waitExit: () => Promise<number>
    }
  ): void {
    this.subprocesses.set(subprocess.pid, {
      conversationId,
      pid: subprocess.pid,
      kill: subprocess.kill,
      waitExit: subprocess.waitExit
    })
    if (this.isShuttingDown) {
      try {
        subprocess.kill()
      } catch (error) {
        logger.warn('Failed to kill subprocess', error)
      }
    }
  }

  untrackSubprocess(pid: number): void {
    this.subprocesses.delete(pid)
  }

  async killAll(): Promise<void> {
    this.isShuttingDown = true
    setMcpWriteGate(null)

    for (const approval of this.pending.values()) {
      approval.resolve({ kind: 'deny' })
    }
    this.pending.clear()

    const tracked = [...this.subprocesses.values()]
    for (const sub of tracked) {
      try {
        sub.kill()
      } catch (error) {
        logger.warn('Failed to kill subprocess', error)
      }
    }
    await Promise.all(tracked.map((sub) => this.reapSubprocess(sub)))

    for (const controller of this.inFlight.values()) {
      controller.abort()
    }
    this.inFlight.clear()
    this.turnLocks.clear()

    const turns = [...this.activeTurns.values()].flatMap((entries) => [...entries])
    if (turns.length > 0) {
      await Promise.allSettled(turns)
    }
    this.activeTurns.clear()
  }

  // A signal sent is not a process gone. Shutdown has to see the exit before it
  // resolves, because main exits moments later and anything still running is
  // reparented to init, out of reach forever. Entries are only dropped once the
  // exit is observed: a survivor stays in the map so a later cancelTurn/killAll
  // still reaches it.
  private async reapSubprocess(sub: TrackedSubprocess): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), KILL_REAP_BUDGET_MS)
    })
    try {
      if (await Promise.race([sub.waitExit().then(() => true), timedOut])) {
        this.subprocesses.delete(sub.pid)
        return
      }
      logger.warn('Agent subprocess still alive after kill', { pid: sub.pid })
    } catch (error) {
      logger.warn('Failed to await agent subprocess exit', { pid: sub.pid, error })
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * A cancelled turn must settle every approval it left on screen. An approval
   * promise nobody resolves strands its MCP tool handler forever, and with it
   * the HTTP response, the socket and the per-request McpServer behind it —
   * which also blocks `server.close()` at quit. Cancelling is never consent, so
   * these always settle as deny; the tool call fails with PERMISSION_DENIED and
   * never runs.
   */
  private denyPendingApprovals(conversationId: string): void {
    for (const [toolCallId, approval] of this.pending) {
      if (approval.conversationId !== conversationId) continue
      this.pending.delete(toolCallId)
      approval.resolve({ kind: 'deny' })
      // The approval card is only ever cleared by a decision event; without
      // this the cancelled turn leaves a dead card the user can still click.
      broadcastAgentEvent({
        kind: 'tool_call_failed',
        conversationId,
        toolCallId,
        error: { code: 'PERMISSION_DENIED', message: 'Turn cancelled before approval.' }
      })
    }
  }

  private waitForApproval(input: PendingApprovalSnapshot): Promise<ApproveToolDecision> {
    return new Promise((resolve) => {
      this.pending.set(input.toolCallId, { ...input, resolve })
    })
  }
}
