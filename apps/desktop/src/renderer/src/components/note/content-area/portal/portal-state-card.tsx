/**
 * The states where a portal cannot show its source (artboard 8). Each is one
 * line: what happened, and the one way forward. The reference itself is never
 * lost.
 *
 * @module note/content-area/portal/portal-state-card
 */

import { useT } from '@memry/i18n/renderer'
import { PORTAL_MAX_DEPTH } from '@memry/shared/portal-block'
import { Layers, RefreshCw, Repeat, Trash, Unlink, type AppIcon } from '@/lib/icons'
import { PortalFrame } from './portal-chrome'
import type { PortalViewStatus } from './portal-state'

export type PortalCardStatus = Exclude<PortalViewStatus, 'ok' | 'loading' | 'locked'>

export interface PortalStateCardProps {
  status: PortalCardStatus
  /** The source's title, when it is known. */
  sourceTitle?: string
  /** The one action each state offers. Omit one and the state shows no button. */
  onAction?: () => void
}

interface CardCopy {
  icon: AppIcon
  text: string
  action: string
}

/** Literal keys, so the i18n scanner sees every one. */
function useCardCopy(status: PortalCardStatus, source: string): CardCopy {
  const { t } = useT('common')
  switch (status) {
    case 'missing-note':
      return {
        icon: Trash,
        text: t('portalBlock.states.missingNote.text'),
        action: t('portalBlock.states.missingNote.action')
      }
    case 'missing-block':
      return {
        icon: Unlink,
        text: t('portalBlock.states.missingBlock.text', { source }),
        action: t('portalBlock.states.missingBlock.action')
      }
    case 'cycle':
      return {
        icon: Repeat,
        text: t('portalBlock.states.cycle.text'),
        action: t('portalBlock.states.cycle.action')
      }
    case 'too-deep':
      return {
        icon: Layers,
        text: t('portalBlock.states.tooDeep.text', { max: PORTAL_MAX_DEPTH }),
        action: t('portalBlock.states.tooDeep.action')
      }
    case 'not-synced':
      return {
        icon: RefreshCw,
        text: t('portalBlock.states.notSynced.text'),
        action: t('portalBlock.states.notSynced.action')
      }
  }
}

export function PortalStateCard({
  status,
  sourceTitle,
  onAction
}: PortalStateCardProps): React.JSX.Element {
  const copy = useCardCopy(status, sourceTitle ?? '')
  const Icon = copy.icon

  return (
    <PortalFrame
      focused={false}
      selected={false}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- ARIA role is intentional here and the native tag would change default styling or behavior
      role="status"
      data-portal-state={status}
      className="flex items-center gap-2 py-1 text-[13px] leading-5 text-text-secondary"
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{copy.text}</span>
      {onAction ? (
        <button
          type="button"
          onClick={onAction}
          className="shrink-0 rounded-sm px-1 text-[13px] font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {copy.action}
        </button>
      ) : null}
    </PortalFrame>
  )
}
