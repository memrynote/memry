import { useEffect, useState } from 'react'

import type { AgentReviewTarget } from '@memry/contracts/ipc-agent'
import { useT } from '@memry/i18n/renderer'

import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationTitle
} from '@/components/ai-elements/confirmation'
import { buildMemryHref } from '@/lib/memry-links'
import type { useAgentOptional } from '../agent-context'
import type { PendingToolApproval } from '../agent-context.reducer'
import { useIsReviewHostMounted } from '../review-hosts'
import { useMemryLinkNavigation } from './memry-links'

/**
 * The agent pane's side of an edit reviewed inside the note or journal.
 *
 * The diff and the decision live on the page. When that page is mounted this
 * only points at it; when it is not, it offers to open it or to accept the
 * change without looking. There is no standing approval here: note and journal
 * body edits ask every time.
 */
export function InPageReviewPointer({
  agent,
  pending,
  target
}: {
  agent: NonNullable<ReturnType<typeof useAgentOptional>>
  pending: PendingToolApproval
  target: AgentReviewTarget
}): React.JSX.Element {
  const { t } = useT('common')
  const navigate = useMemryLinkNavigation()
  const hostMounted = useIsReviewHostMounted(target)
  const [title, setTitle] = useState<string | null>(null)
  const [accepting, setAccepting] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api.agent
      .previewDiff({ conversationId: pending.conversationId, toolCallId: pending.toolCallId })
      .then((result) => {
        if (!cancelled) setTitle(result.preview.item.title || result.title || null)
      })
      .catch(() => {
        // The title is a nicety; the fallback below still names the item.
      })
    return () => {
      cancelled = true
    }
  }, [pending.conversationId, pending.toolCallId])

  const name =
    title ?? (target.kind === 'journal' ? target.date : t('agentChat.inPageReview.fallbackTitle'))

  function openTarget(): void {
    const href = buildMemryHref({
      kind: target.kind,
      id: target.kind === 'note' ? target.id : target.date,
      label: title
    })
    if (href) navigate(href, title ?? undefined)
  }

  function accept(): void {
    if (accepting) return
    setAccepting(true)
    void agent
      .approveTool({
        conversationId: pending.conversationId,
        toolCallId: pending.toolCallId,
        decision: { kind: 'allow' }
      })
      .finally(() => setAccepting(false))
  }

  return (
    <Confirmation state="pending">
      <ConfirmationTitle>
        {hostMounted
          ? t('agentChat.inPageReview.waiting', { title: name })
          : t('agentChat.inPageReview.notOpen', { title: name })}
      </ConfirmationTitle>
      <ConfirmationActions>
        {hostMounted ? (
          <ConfirmationAction onClick={openTarget}>
            {t('agentChat.inPageReview.show')}
          </ConfirmationAction>
        ) : (
          <>
            <ConfirmationAction onClick={openTarget}>
              {target.kind === 'note'
                ? t('agentChat.inPageReview.openNote')
                : t('agentChat.inPageReview.openJournal')}
            </ConfirmationAction>
            <ConfirmationAction
              tone="primary"
              disabled={accepting}
              onPointerDown={(event) => {
                if (event.button !== 0) return
                event.preventDefault()
                accept()
              }}
              onClick={accept}
            >
              {t('agentChat.inPageReview.accept')}
            </ConfirmationAction>
          </>
        )}
      </ConfirmationActions>
    </Confirmation>
  )
}
