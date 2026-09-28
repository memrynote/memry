import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { AgentReviewTarget } from '@memry/contracts/ipc-agent'
import { useT } from '@memry/i18n/renderer'

import { useAgentOptional } from '@/agent-chat/agent-context'
import type { PendingToolApproval } from '@/agent-chat/agent-context.reducer'
import { editedArgsWithCandidate } from '@/agent-chat/approval-args'
import { buildBodyChunks } from '@/agent-chat/messages/change-preview'
import { registerReviewHost } from '@/agent-chat/review-hosts'
import { extractErrorMessage } from '@/lib/ipc-error'
import { flushAllPendingSaves } from '@/lib/save-registry'
import { onJournalEntryUpdated, onJournalExternalChange } from '@/services/journal-service'
import { onNoteUpdated } from '@/services/notes-service'

/** Coalesces the burst of events one external write produces. */
const REFRESH_DEBOUNCE_MS = 250

export type AgentReviewMode = 'diff' | 'edit'

export interface AgentBodyReview {
  pending: PendingToolApproval
  title: string | null
  /** The body on disk now, or null while the first preview loads. */
  current: string | null
  /** The agent's proposal applied to `current`. */
  candidate: string | null
  /** The user's edit of the proposal, or null while they have not typed. */
  draft: string | null
  mode: AgentReviewMode
  /** Bumped when the draft editor has to reload from `candidate`. */
  draftEpoch: number
  /** The note changed underneath a draft the user is still editing. */
  baseChanged: boolean
  error: string | null
  submitting: boolean
  changeCount: number
  /** Registered by the draft editor so Accept can flush its debounced save. */
  flushDraftRef: React.RefObject<(() => Promise<void>) | null>
  startEdit: () => void
  showDiff: () => void
  setDraft: (markdown: string) => void
  restartFromLatest: () => void
  keepDraft: () => void
  accept: () => Promise<void>
  reject: () => Promise<void>
}

interface ReviewState {
  toolCallId: string
  title: string | null
  current: string | null
  candidate: string | null
  draft: string | null
  mode: AgentReviewMode
  draftEpoch: number
  baseChanged: boolean
  error: string | null
  submitting: boolean
}

function freshState(toolCallId: string): ReviewState {
  return {
    toolCallId,
    title: null,
    current: null,
    candidate: null,
    draft: null,
    mode: 'diff',
    draftEpoch: 0,
    baseChanged: false,
    error: null,
    submitting: false
  }
}

function sameTarget(
  left: AgentReviewTarget | null | undefined,
  right: AgentReviewTarget | null
): boolean {
  if (!left || !right || left.kind !== right.kind) return false
  return left.kind === 'note'
    ? right.kind === 'note' && left.id === right.id
    : right.kind === 'journal' && left.date === right.date
}

/**
 * Drives the in-page review of an agent's body edit for one note or journal.
 *
 * Returns null while nothing is pending for `target`. The page stays the owner
 * of its live editor; this only says what to draw instead of it and settles the
 * approval the agent is waiting on. Nothing here writes the note: an edited
 * draft lives in React state until Accept hands it to the gate, so a proposal
 * the user has not accepted never reaches the Y.Doc or another device.
 */
export function useAgentBodyReview(target: AgentReviewTarget | null): AgentBodyReview | null {
  const { t } = useT('common')
  const agent = useAgentOptional()
  const approveTool = agent?.approveTool
  const pending = useMemo(
    () =>
      agent?.state.pendingApprovals.find((approval) => sameTarget(approval.reviewTarget, target)) ??
      null,
    [agent?.state.pendingApprovals, target]
  )
  const toolCallId = pending?.toolCallId ?? null

  const [state, setState] = useState<ReviewState | null>(null)
  const [revision, setRevision] = useState(0)
  const flushDraftRef = useRef<(() => Promise<void>) | null>(null)
  // Read by Accept right after flushing the draft editor, before React has
  // re-rendered with the flushed text, so it is written where the text arrives.
  const draftRef = useRef<string | null>(null)
  const flushedSavesForRef = useRef<string | null>(null)
  // Buttons fire on pointerdown with a click fallback for the keyboard, so one
  // press can arrive twice.
  const decidingRef = useRef(false)

  // A different approval is a different review: start clean.
  const live = toolCallId && state?.toolCallId === toolCallId ? state : null
  if (toolCallId && !live) setState(freshState(toolCallId))
  if (!toolCallId && state) setState(null)

  useEffect(() => {
    draftRef.current = null
  }, [toolCallId])

  useEffect(() => {
    if (!target) return
    return registerReviewHost(target)
  }, [target])

  // The note changing under the review, from sync, another window or the file
  // on disk, re-reads the preview so the diff is always against what is there.
  useEffect(() => {
    if (!toolCallId || !target) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const bump = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setRevision((value) => value + 1), REFRESH_DEBOUNCE_MS)
    }
    const unsubscribers =
      target.kind === 'note'
        ? [
            onNoteUpdated((event) => {
              if (event.id === target.id) bump()
            })
          ]
        : [
            onJournalEntryUpdated((event) => {
              if (event.date === target.date) bump()
            }),
            onJournalExternalChange((event) => {
              if (event.date === target.date) bump()
            })
          ]
    return () => {
      if (timer) clearTimeout(timer)
      for (const unsubscribe of unsubscribers) unsubscribe()
    }
  }, [toolCallId, target])

  const conversationId = pending?.conversationId ?? null
  useEffect(() => {
    if (!toolCallId || !conversationId) return
    let cancelled = false

    void (async () => {
      try {
        // Edits typed a moment before the proposal arrived may still sit in a
        // debounced save. The preview has to diff against them, not without.
        if (flushedSavesForRef.current !== toolCallId) {
          flushedSavesForRef.current = toolCallId
          await flushAllPendingSaves()
        }
        const result = await window.api.agent.previewDiff({ conversationId, toolCallId })
        if (cancelled) return
        const current = result.preview.body?.current ?? result.current
        const candidate = result.preview.body?.candidate ?? result.candidate
        setState((prev) => {
          if (!prev || prev.toolCallId !== toolCallId || prev.submitting) return prev
          const baseMoved = prev.current !== null && prev.current !== current
          return {
            ...prev,
            title: result.preview.item.title || result.title,
            current,
            candidate,
            error: null,
            baseChanged: prev.baseChanged || (baseMoved && prev.draft !== null)
          }
        })
      } catch (err) {
        if (cancelled) return
        setState((prev) =>
          prev && prev.toolCallId === toolCallId && !prev.submitting
            ? { ...prev, error: extractErrorMessage(err, t('agentChat.diff.previewError')) }
            : prev
        )
      }
    })()

    return () => {
      cancelled = true
    }
  }, [toolCallId, conversationId, revision, t])

  const update = useCallback(
    (patch: Partial<ReviewState>) => {
      setState((prev) => (prev && prev.toolCallId === toolCallId ? { ...prev, ...patch } : prev))
    },
    [toolCallId]
  )

  const decide = useCallback(
    async (kind: 'accept' | 'reject') => {
      if (!pending || !approveTool || decidingRef.current) return
      decidingRef.current = true
      update({ submitting: true })
      if (kind === 'reject') {
        await approveTool({
          conversationId: pending.conversationId,
          toolCallId: pending.toolCallId,
          decision: { kind: 'deny' }
        })
      } else {
        // The draft editor saves on a short debounce; the last keystrokes
        // before the click must be in what gets accepted.
        await flushDraftRef.current?.()
        const draft = draftRef.current
        const candidate = live?.candidate ?? null
        const edited = draft !== null && draft !== candidate
        await approveTool({
          conversationId: pending.conversationId,
          toolCallId: pending.toolCallId,
          decision: edited
            ? {
                kind: 'edit_allow',
                editedArgs: editedArgsWithCandidate(pending.args, draft, pending.name)
              }
            : { kind: 'allow' }
        })
      }
      // A successful decision clears the approval and unmounts this review. One
      // that failed leaves it pending, and the user can try again.
      decidingRef.current = false
      update({ submitting: false })
    },
    [approveTool, live?.candidate, pending, update]
  )

  const changeCount = useMemo(() => {
    if (!live || live.current === null) return 0
    const next = live.draft ?? live.candidate ?? live.current
    return buildBodyChunks(live.current, next).filter((chunk) => chunk.kind === 'changed').length
  }, [live])

  if (!pending || !live) return null

  return {
    pending,
    title: live.title,
    current: live.current,
    candidate: live.candidate,
    draft: live.draft,
    mode: live.mode,
    draftEpoch: live.draftEpoch,
    baseChanged: live.baseChanged,
    error: live.error,
    submitting: live.submitting,
    changeCount,
    flushDraftRef,
    startEdit: () => update({ mode: 'edit' }),
    showDiff: () => {
      // The draft editor unmounts on the switch and its teardown flush is
      // ignored (see DraftEditor), so the last keystrokes are taken first.
      void (flushDraftRef.current?.() ?? Promise.resolve()).then(() => update({ mode: 'diff' }))
    },
    setDraft: (markdown) => {
      draftRef.current = markdown
      update({ draft: markdown })
    },
    restartFromLatest: () => {
      draftRef.current = null
      update({
        draft: null,
        baseChanged: false,
        mode: 'edit',
        draftEpoch: live.draftEpoch + 1
      })
    },
    keepDraft: () => update({ baseChanged: false }),
    accept: () => decide('accept'),
    reject: () => decide('reject')
  }
}
