import { useCallback, useEffect, useRef } from 'react'

import { useT } from '@memry/i18n/renderer'

import { ContentArea } from '@/components/note/content-area'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { AgentDiffBody } from './agent-diff-body'
import type { AgentBodyReview } from './use-agent-body-review'

/**
 * What a note or journal page draws in place of its editor while an agent edit
 * waits for the user: the change inline, and a bar to settle it.
 *
 * The live editor stays mounted (hidden) behind this, bound to the Y.Doc as
 * before, so nothing about the note's own state moves while the user decides.
 */
export function AgentReviewSurface({
  review,
  noteId,
  notePath,
  placeholder
}: {
  review: AgentBodyReview
  noteId?: string
  notePath?: string
  placeholder?: string
}): React.JSX.Element {
  const { t } = useT('common')
  const next = review.draft ?? review.candidate

  return (
    <section
      aria-label={t('agentChat.inPageReview.regionLabel')}
      data-testid="agent-review-surface"
      // The page's marquee selection and click-below-to-focus both target the
      // note's own editor, which is hidden while this is up.
      data-marquee-ignore
      className="flex flex-col"
    >
      {review.current === null || next === null ? (
        <p className="py-2 text-sm text-muted-foreground">
          {review.error ?? t('agentChat.inPageReview.loading')}
        </p>
      ) : review.mode === 'edit' ? (
        <DraftEditor
          key={`${review.pending.toolCallId}:${review.draftEpoch}`}
          review={review}
          initialContent={next}
          notePath={notePath}
          placeholder={placeholder}
        />
      ) : (
        <AgentDiffBody current={review.current} next={next} noteId={noteId} notePath={notePath} />
      )}
      <AgentReviewBar review={review} />
    </section>
  )
}

/**
 * The editable copy of the proposal. A standalone editor on purpose: without a
 * note id it binds no Y.Doc and runs no task side effects, so typing here
 * cannot reach the note, the vault file or another device until Accept.
 */
function DraftEditor({
  review,
  initialContent,
  notePath,
  placeholder
}: {
  review: AgentBodyReview
  initialContent: string
  notePath?: string
  placeholder?: string
}): React.JSX.Element {
  const { setDraft, flushDraftRef } = review
  // The editor flushes its last edit when it unmounts. After "start over" that
  // flush belongs to a draft the user just threw away, so it must not land.
  const liveRef = useRef(true)
  useEffect(() => {
    liveRef.current = true
    return () => {
      liveRef.current = false
    }
  }, [])
  const handleMarkdownChange = useCallback(
    (markdown: string) => {
      if (liveRef.current) setDraft(markdown)
    },
    [setDraft]
  )

  return (
    <ContentArea
      initialContent={initialContent}
      contentType="markdown"
      notePath={notePath}
      placeholder={placeholder}
      onMarkdownChange={handleMarkdownChange}
      flushMarkdownRef={flushDraftRef}
      runSideEffects={false}
      autoFocus
    />
  )
}

/**
 * Fired on pointerdown: Accept and Reject disable themselves while the
 * decision is in flight, and a button that disables between pointerdown and
 * click loses the click. `onClick` stays as the keyboard path.
 */
function pressHandlers(run: () => void): {
  onPointerDown: (event: React.PointerEvent) => void
  onClick: () => void
} {
  return {
    onPointerDown: (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      run()
    },
    onClick: run
  }
}

function AgentReviewBar({ review }: { review: AgentBodyReview }): React.JSX.Element {
  const { t } = useT('common')
  const editing = review.mode === 'edit'
  const edited = review.draft !== null && review.draft !== review.candidate
  const loaded = review.current !== null

  const title = editing
    ? t('agentChat.inPageReview.editingTitle')
    : loaded
      ? t('agentChat.inPageReview.title', { count: review.changeCount })
      : t('agentChat.inPageReview.loadingTitle')
  const hint = review.error
    ? review.error
    : editing
      ? t('agentChat.inPageReview.editingHint')
      : t('agentChat.inPageReview.pendingHint')

  return (
    <div
      role="region"
      aria-label={t('agentChat.inPageReview.barLabel')}
      className="sticky bottom-6 z-20 mt-6 flex flex-col gap-2.5 rounded-xl border border-border bg-background p-2.5 ps-4 shadow-lg"
    >
      {review.baseChanged ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted px-3 py-2 text-xs text-text-secondary">
          <span className="min-w-0 flex-1">{t('agentChat.inPageReview.baseChanged')}</span>
          <Button size="sm" variant="ghost" onClick={review.keepDraft}>
            {t('agentChat.inPageReview.keepDraft')}
          </Button>
          <Button size="sm" variant="outline" onClick={review.restartFromLatest}>
            {t('agentChat.inPageReview.restart')}
          </Button>
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium text-foreground">{title}</span>
          <span
            className={cn(
              'truncate text-xs',
              review.error ? 'text-destructive' : 'text-muted-foreground'
            )}
          >
            {hint}
          </span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          disabled={review.submitting}
          {...pressHandlers(() => void review.reject())}
        >
          {t('agentChat.inPageReview.reject')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={review.submitting || !loaded}
          onClick={editing ? review.showDiff : review.startEdit}
        >
          {editing ? t('agentChat.inPageReview.showDiff') : t('agentChat.inPageReview.edit')}
        </Button>
        <Button
          size="sm"
          disabled={review.submitting || (!loaded && !review.error)}
          {...pressHandlers(() => void review.accept())}
        >
          {edited ? t('agentChat.inPageReview.acceptEdits') : t('agentChat.inPageReview.accept')}
        </Button>
      </div>
    </div>
  )
}
