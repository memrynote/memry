/**
 * The states where a portal cannot show its source (artboard 7). Each names
 * the cause and offers one action; the reference itself is never lost.
 *
 * @module note/content-area/portal/portal-state-card
 */

import { useT } from '@memry/i18n/renderer'
import { PORTAL_MAX_DEPTH } from '@memry/shared/portal-block'
import { PortalGlyph, PortalHeaderRow, PortalRail } from './portal-chrome'
import type { PortalViewStatus } from './portal-state'

export type PortalCardStatus = Exclude<PortalViewStatus, 'ok' | 'loading' | 'locked'>

export interface PortalStateCardProps {
  status: PortalCardStatus
  /** The source's title, when it is known. */
  sourceTitle?: string
  /** "Title › block" for the card's header; falls back to `sourceTitle`. */
  breadcrumb?: string
  /** The one action each state offers. Omit one and the state shows no button. */
  onAction?: () => void
}

interface CardCopy {
  title: string
  body: string
  action: string
}

/** Literal keys, so the i18n scanner sees every one. */
function useCardCopy(status: PortalCardStatus, source: string): CardCopy {
  const { t } = useT('common')
  switch (status) {
    case 'missing-note':
      return {
        title: t('portalBlock.states.missingNote.title'),
        body: t('portalBlock.states.missingNote.body'),
        action: t('portalBlock.states.missingNote.action')
      }
    case 'missing-block':
      return {
        title: t('portalBlock.states.missingBlock.title'),
        body: t('portalBlock.states.missingBlock.body'),
        action: t('portalBlock.states.missingBlock.action')
      }
    case 'cycle':
      return {
        title: t('portalBlock.states.cycle.title'),
        body: t('portalBlock.states.cycle.body', { source }),
        action: t('portalBlock.states.cycle.action')
      }
    case 'too-deep':
      return {
        title: t('portalBlock.states.tooDeep.title'),
        body: t('portalBlock.states.tooDeep.body', { max: PORTAL_MAX_DEPTH }),
        action: t('portalBlock.states.tooDeep.action')
      }
    case 'not-synced':
      return {
        title: t('portalBlock.states.notSynced.title', { source }),
        body: t('portalBlock.states.notSynced.body'),
        action: t('portalBlock.states.notSynced.action')
      }
  }
}

export function PortalStateCard({
  status,
  sourceTitle,
  breadcrumb,
  onAction
}: PortalStateCardProps): React.JSX.Element {
  const copy = useCardCopy(status, sourceTitle ?? '')
  const header = breadcrumb ?? sourceTitle

  return (
    <PortalRail tone="neutral" role="status" data-portal-state={status}>
      {header ? (
        <PortalHeaderRow>
          <PortalGlyph className="text-muted-foreground" />
          <span className="truncate text-xs font-medium text-muted-foreground">{header}</span>
        </PortalHeaderRow>
      ) : null}
      <div className="flex flex-col">
        <div className="text-sm font-medium leading-5 text-foreground">{copy.title}</div>
        <div className="text-xs leading-[17px] text-muted-foreground">{copy.body}</div>
      </div>
      {onAction ? (
        <button
          type="button"
          onClick={onAction}
          className="self-start rounded-md border border-border px-3 py-1.5 text-[13px] font-medium leading-[18px] text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {copy.action}
        </button>
      ) : null}
    </PortalRail>
  )
}
