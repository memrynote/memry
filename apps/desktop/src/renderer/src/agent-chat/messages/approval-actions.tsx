import type { AlwaysAllowScope } from '@memry/contracts/ipc-agent'
import { useT } from '@memry/i18n/renderer'

import {
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationActionsSpacer
} from '@/components/ai-elements/confirmation'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ChevronDown } from '@/lib/icons'

export interface ApprovalActionsProps {
  approveLabel: string
  onApprove: () => void
  onReject: () => void
  editLabel?: string
  onEdit?: () => void
  /**
   * Absent for a tool that cannot carry a standing approval. Today that is
   * every delete: the gate refuses to trust one, so offering the menu would be
   * a control that does nothing.
   */
  onAllowAlways?: (scope: AlwaysAllowScope) => void
  /** Human name of the tool, for the sentence under the row. */
  toolLabel?: string
  approveDisabled?: boolean
}

/**
 * The decision row of an approval card.
 *
 * One component for both the preview card and the plain argument card, because
 * the buttons are the contract the user learns once: approve on the inline
 * start, reject pushed to the far end, and the standing approval behind a menu
 * that makes the user pick how long it lasts.
 */
export function ApprovalActions({
  approveLabel,
  onApprove,
  onReject,
  editLabel,
  onEdit,
  onAllowAlways,
  toolLabel,
  approveDisabled
}: ApprovalActionsProps): React.JSX.Element {
  const { t } = useT('common')

  return (
    <div className="flex flex-col gap-2.5">
      <ConfirmationActions>
        <ConfirmationAction tone="primary" disabled={approveDisabled} onClick={onApprove}>
          {approveLabel}
        </ConfirmationAction>
        {onEdit && editLabel ? (
          <ConfirmationAction onClick={onEdit}>{editLabel}</ConfirmationAction>
        ) : null}
        {onAllowAlways ? <AlwaysAllowMenu onAllowAlways={onAllowAlways} /> : null}
        <ConfirmationActionsSpacer />
        <ConfirmationAction tone="quiet-destructive" onClick={onReject}>
          {t('agentChat.approval.deny')}
        </ConfirmationAction>
      </ConfirmationActions>
      {onAllowAlways ? (
        <p className="text-[11px] leading-4 text-text-tertiary">
          {t('agentChat.approval.alwaysAllowHint', {
            tool: toolLabel ?? t('agentChat.approval.thisTool')
          })}
        </p>
      ) : null}
    </div>
  )
}

/**
 * The scope is a menu rather than a single button because the two answers
 * expire differently, and a user who cannot see that difference cannot give
 * informed consent to the longer one.
 */
function AlwaysAllowMenu({
  onAllowAlways
}: {
  onAllowAlways: (scope: AlwaysAllowScope) => void
}): React.JSX.Element {
  const { t } = useT('common')

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ConfirmationAction className="gap-1.5 pe-2">
          {t('agentChat.approval.allowAlways')}
          <ChevronDown aria-hidden className="size-3" />
        </ConfirmationAction>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[262px]">
        <DropdownMenuItem
          className="flex-col items-start gap-px"
          onSelect={() => onAllowAlways('conversation')}
        >
          <span className="text-[13px] text-foreground">
            {t('agentChat.approval.alwaysInChat')}
          </span>
          <span className="text-[11px] text-text-tertiary">
            {t('agentChat.approval.alwaysInChatHint')}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className="flex-col items-start gap-px"
          onSelect={() => onAllowAlways('vault')}
        >
          <span className="text-[13px] text-foreground">
            {t('agentChat.approval.alwaysInVault')}
          </span>
          <span className="text-[11px] text-text-tertiary">
            {t('agentChat.approval.alwaysInVaultHint')}
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled className="text-[13px] text-text-tertiary">
          {t('agentChat.approval.deletesAlwaysAsk')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
