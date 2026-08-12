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

/**
 * What a pending approval can settle as. `expired` is runtime-only: the user
 * never answered and the runtime settled the request itself. It is deliberately
 * NOT an `ApproveToolDecision` — nothing outside this file may produce it, and
 * it must never be reported to the user or the model as a denial.
 */
type ApprovalOutcome = ApproveToolDecision | { kind: 'expired' }

interface PendingApproval {
  resolve: (outcome: ApprovalOutcome) => void
  timer: ReturnType<typeof setTimeout>
  conversationId: string
  toolCallId: string
  name: string
  /**
   * Kept whole, on purpose. Slicing this frees nothing: it is the same object
   * the suspended MCP tool handler already holds across its await
   * (`write-tools.ts` gateOrDeny) and that the gate closure below reads after
   * its own await. And it is the only source `agent:previewDiff` has for the
   * approval diff, so a slice would break the preview on exactly the large
   * notes that would motivate slicing. Bounding the lifetime — the deadline
   * below — is what actually releases it.
   */
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

// How long an approval may sit unanswered before the runtime settles it itself.
//
// Without a deadline the entry lives as long as the app: it pins the parsed
// args, the suspended MCP tool handler, its HTTP response and socket, and the
// per-request McpServer behind it — the same chain that blocks server.close()
// at quit. One prompt left on screen while the user walks away is enough.
//
// Half an hour, not the five minutes the issue first suggested. Auto-denying is
// the one outcome we must not get wrong: the model is told the call did not go
// through, and a deadline that can elapse while someone reads a diff turns
// "I stepped away" into "the user refused". Against a leak measured in days,
// the retention difference between 5 and 30 minutes is noise, while the odds of
// firing under a reader's hands are not. Deliberately not gated on window
// focus either — the leak *is* the app sitting in the background, so a
// focus-gated timer would never fire in the case it exists to bound, and an
// approval can sit in a window the user is not currently looking at.
const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000

// Shown to the user in the failed tool call, and handed to the model as the
// gate's reason. Both have to say "expired", never "denied" — the user did not
// refuse anything, and the model must not tell them they did.
const APPROVAL_EXPIRED_MESSAGE =
  'Approval request expired after 30 minutes with no answer. This was not a denial — the tool did not run; ask again if it is still needed.'

export interface AgentRuntimeDeps {
  conversations: ConversationStore
  messages: MessageStore
  getPreferences?: () => AgentPreferences
  /** Overridable for tests. Defaults to {@link APPROVAL_TIMEOUT_MS}. */
  approvalTimeoutMs?: number
}

export type PendingApprovalSnapshot = Omit<PendingApproval, 'resolve' | 'timer'>

function trackApprovalDecided(decision: string, result: 'success' | 'failed'): void {
  trackMainEvent('ai_action_completed', {
    surface: 'ai',
    action: 'tool_approval_decided',
    result,
    dimensions: { decision: toSafeToken(decision, 'unknown') }
  })
}

export class AgentRuntime {
  private pending = new Map<string, PendingApproval>()
  private subprocesses = new Map<number, TrackedSubprocess>()
  // Conversations whose stop was pressed while no run handle existed yet.
  //
  // This is NOT a second cancellation mechanism: killing the tracked run handle
  // is still the only thing that stops work. The flag exists because the handle
  // can arrive *after* the decision to stop was taken, and `subprocesses` is
  // empty for the whole of `await backend.runTurn(...)` — the local backend
  // awaits a two-round-trip capability probe before it constructs its handle,
  // the CLI backends await a spawn. A stop landing in that window used to walk
  // an empty map and silently do nothing while the turn ran to completion.
  private cancelRequested = new Set<string>()
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
      // An expiry is its own label for the same reason: neither is a decision
      // the user made, and collapsing them into `deny` would overstate how
      // often people actually refuse a tool call.
      trackApprovalDecided(
        this.isShuttingDown && userDecision.kind === 'deny' ? 'abandoned' : userDecision.kind,
        userDecision.kind === 'deny' || userDecision.kind === 'expired' ? 'failed' : 'success'
      )
      if (userDecision.kind === 'expired') {
        return { approved: false, reason: APPROVAL_EXPIRED_MESSAGE }
      }
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
    if (!this.settleApproval(toolCallId, decision)) {
      logger.warn(`Stale approval for ${toolCallId}`)
    }
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

  // Killing the tracked run handles is the whole of cancellation. Every backend
  // reaches this map: BackendRunHandle requires `kill()`, and turn.ts routes each
  // handle through trackRunHandle -> trackSubprocess. For the CLI backends that
  // kill is a signal to a real child; for the in-process local backend it is the
  // AbortController driving streamText, registered under a negative pseudo-pid.
  cancelTurn(conversationId: string): void {
    // Recorded before the loop, so a handle still being built by an in-flight
    // backend.runTurn() is killed the instant it registers (see trackSubprocess)
    // instead of being missed by the walk below.
    this.cancelRequested.add(conversationId)
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
    // A stop pressed against an earlier turn must never reach this one. Safe
    // because this lock serializes turns per conversation: the previous turn
    // registered its last run handle before its own releaseTurnLock, so there is
    // nothing left for the flag to catch by the time a new turn can acquire.
    this.cancelRequested.delete(conversationId)
  }

  releaseTurnLock(conversationId: string): void {
    this.turnLocks.delete(conversationId)
    // Same reasoning, from the other end: the turn is over and produced its last
    // handle before this ran, so dropping the flag here keeps the set bounded
    // rather than holding an id until that conversation is used again.
    this.cancelRequested.delete(conversationId)
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
    // Two late-arrival cases, one remedy: quit or stop was decided while this
    // handle did not exist yet, so the walk in killAll/cancelTurn could not see
    // it. This kill is the one that walk would have performed. The entry stays
    // in the map either way — cleanup() is what untracks it.
    if (this.isShuttingDown || this.cancelRequested.has(conversationId)) {
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

    for (const toolCallId of [...this.pending.keys()]) {
      this.settleApproval(toolCallId, { kind: 'deny' })
    }

    const tracked = [...this.subprocesses.values()]
    for (const sub of tracked) {
      try {
        sub.kill()
      } catch (error) {
        logger.warn('Failed to kill subprocess', error)
      }
    }
    await Promise.all(tracked.map((sub) => this.reapSubprocess(sub)))

    this.turnLocks.clear()
    this.cancelRequested.clear()

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
    for (const [toolCallId, approval] of [...this.pending]) {
      if (approval.conversationId !== conversationId) continue
      this.settleApproval(toolCallId, { kind: 'deny' })
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

  /**
   * Nobody answered in time. Settle the awaiting tool call so its MCP handler,
   * socket and per-request server are released, and clear the card the user
   * left on screen.
   *
   * The code is `APPROVAL_EXPIRED`, not `PERMISSION_DENIED`: the renderer maps
   * `PERMISSION_DENIED` to the "Denied" chip, which would tell the user they
   * refused something they never saw a decision on. Any other code lands on the
   * generic error chip and surfaces the message below, which says what actually
   * happened. Card clearing does not depend on the code — the reducer drops the
   * pending approval for every `tool_call_failed`.
   */
  private expireApproval(toolCallId: string): void {
    const approval = this.settleApproval(toolCallId, { kind: 'expired' })
    if (!approval) return

    logger.warn(`Approval ${toolCallId} expired with no decision`)
    broadcastAgentEvent({
      kind: 'tool_call_failed',
      conversationId: approval.conversationId,
      toolCallId,
      error: { code: 'APPROVAL_EXPIRED', message: APPROVAL_EXPIRED_MESSAGE }
    })
  }

  /**
   * The single exit for a pending approval: drop the entry, cancel its
   * deadline, then resolve. Clearing the timer matters as much as deleting the
   * entry — an orphaned timer would fire on an id that is gone and, before
   * `unref`, would also have kept the event loop alive.
   */
  private settleApproval(toolCallId: string, outcome: ApprovalOutcome): PendingApproval | null {
    const approval = this.pending.get(toolCallId)
    if (!approval) return null

    clearTimeout(approval.timer)
    this.pending.delete(toolCallId)
    approval.resolve(outcome)
    return approval
  }

  private waitForApproval(input: PendingApprovalSnapshot): Promise<ApprovalOutcome> {
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => this.expireApproval(input.toolCallId),
        this.deps.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS
      )
      // An unanswered prompt must not be the reason the process refuses to exit.
      timer.unref?.()
      this.pending.set(input.toolCallId, { ...input, resolve, timer })
    })
  }
}
