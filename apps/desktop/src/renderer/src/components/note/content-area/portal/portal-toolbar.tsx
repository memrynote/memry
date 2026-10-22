/**
 * The toolbar that floats over a portal while the caret is inside it
 * (artboard 5): the path from the note down to the portal, the count of hidden
 * neighbours, and one menu. It takes no layout space.
 *
 * @module note/content-area/portal/portal-toolbar
 */

import { useT } from '@memry/i18n/renderer'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  ChevronRight,
  Copy,
  EyeOff,
  Layers,
  Link,
  Lock,
  MoreHorizontal,
  PanelRight,
  X
} from '@/lib/icons'
import { PortalToolbarButton, PortalToolbarShell } from './portal-chrome'
import type { PortalWindowBlock } from './portal-window-plugin'

/** Crumbs beyond this many ancestors fold into an ellipsis. */
const MAX_CRUMBS = 2

export interface PortalToolbarProps {
  /** The source note's title; empty while it loads. */
  title: string
  /** From the note's top to the first root. */
  ancestors: readonly PortalWindowBlock[]
  /** Blocks beside the roots that the portal does not show. */
  hiddenSiblingCount: number
  locked: boolean
  /** Only the lock notice: the toolbar of a locked portal with no caret in it. */
  compact: boolean
  editable: boolean
  onIncludeParent: (ancestor: PortalWindowBlock) => void
  onOpenHidden: (anchorEl: HTMLElement) => void
  onOpenSource: () => void
  onOpenBeside: () => void
  onCopyContents: () => void
  onCopyLink: () => void
  onRemove: () => void
  /** Reports the menu opening or closing, so the toolbar stays while it is used. */
  onMenuOpenChange: (open: boolean) => void
}

function Crumb({
  ancestor,
  onInclude,
  disabled
}: {
  ancestor: PortalWindowBlock
  onInclude: (ancestor: PortalWindowBlock) => void
  disabled: boolean
}): React.JSX.Element {
  const { t } = useT('common')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <PortalToolbarButton
          disabled={disabled}
          onClick={() => onInclude(ancestor)}
          className="max-w-[9rem]"
        >
          <span className="truncate">{ancestor.text}</span>
        </PortalToolbarButton>
      </TooltipTrigger>
      <TooltipContent side="top">
        {t('portalBlock.toolbar.include', { block: ancestor.text })}
      </TooltipContent>
    </Tooltip>
  )
}

export function PortalToolbar({
  title,
  ancestors,
  hiddenSiblingCount,
  locked,
  compact,
  editable,
  onIncludeParent,
  onOpenHidden,
  onOpenSource,
  onOpenBeside,
  onCopyContents,
  onCopyLink,
  onRemove,
  onMenuOpenChange
}: PortalToolbarProps): React.JSX.Element {
  const { t } = useT('common')
  const shown = ancestors.slice(-MAX_CRUMBS)
  const folded = ancestors.length > shown.length

  return (
    <TooltipProvider delayDuration={300}>
      <PortalToolbarShell aria-label={t('portalBlock.toolbar.label')}>
        {compact ? null : (
          <PortalToolbarButton onClick={onOpenSource} className="max-w-[10rem]">
            <Layers className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{title || '\u00a0'}</span>
          </PortalToolbarButton>
        )}
        {folded && !compact ? (
          <>
            <ChevronRight className="size-3 shrink-0 text-text-tertiary" aria-hidden="true" />
            <span className="px-0.5 text-text-tertiary">{'\u2026'}</span>
          </>
        ) : null}
        {(compact ? [] : shown).map((ancestor) => (
          <span key={ancestor.blockId} className="flex min-w-0 items-center gap-0.5">
            <ChevronRight className="size-3 shrink-0 text-text-tertiary" aria-hidden="true" />
            <Crumb ancestor={ancestor} onInclude={onIncludeParent} disabled={!editable} />
          </span>
        ))}
        {locked ? (
          <span className="flex shrink-0 items-center gap-1 px-1.5 text-[11px] font-medium text-text-secondary">
            <Lock className="size-3" aria-hidden="true" />
            {t('portalBlock.toolbar.locked', { note: title })}
          </span>
        ) : null}
        {hiddenSiblingCount > 0 && !compact ? (
          <PortalToolbarButton onClick={(event) => onOpenHidden(event.currentTarget)}>
            <EyeOff className="size-3 shrink-0" aria-hidden="true" />
            {t('portalBlock.hiddenCount', { count: hiddenSiblingCount })}
          </PortalToolbarButton>
        ) : null}
        {compact ? null : (
          <DropdownMenu onOpenChange={onMenuOpenChange}>
            <DropdownMenuTrigger asChild>
              <PortalToolbarButton aria-label={t('portalBlock.toolbar.more')} className="px-1">
                <MoreHorizontal className="size-3.5" aria-hidden="true" />
              </PortalToolbarButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuItem onSelect={onOpenBeside}>
                <PanelRight className="size-4" aria-hidden="true" />
                <span className="flex-1 truncate">
                  {t('portalBlock.toolbar.openBeside', { note: title })}
                </span>
                <KbdGroup>
                  <Kbd>{'\u21E7'}</Kbd>
                  <Kbd>{t('portalBlock.toolbar.click')}</Kbd>
                </KbdGroup>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onCopyContents}>
                <Copy className="size-4" aria-hidden="true" />
                {t('portalBlock.toolbar.copyContents')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onCopyLink}>
                <Link className="size-4" aria-hidden="true" />
                {t('portalBlock.toolbar.copyLink')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onRemove} disabled={!editable}>
                <X className="size-4" aria-hidden="true" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span>{t('portalBlock.toolbar.remove')}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {t('portalBlock.toolbar.removeHint', { note: title })}
                  </span>
                </span>
                <Kbd>{'\u232B'}</Kbd>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </PortalToolbarShell>
    </TooltipProvider>
  )
}
