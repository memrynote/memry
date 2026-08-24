import { useCallback } from 'react'
import { RotateCw } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'
import { useAppUpdater } from '@/hooks/use-app-updater'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { createLogger } from '@/lib/logger'

const log = createLogger('Component:SidebarUpdateButton')

/**
 * Accent button pinned above the sync/vault/settings row in the sidebar footer.
 * Updates download silently, so the button surfaces only the one phase that
 * needs the user:
 *   downloaded → "Restart" (click quits + installs)
 * Hidden in every other state — 'available' and 'downloading' stay invisible.
 */
export function SidebarUpdateButton() {
  const { t } = useT('common')
  const { state, quitAndInstall } = useAppUpdater()
  const { status } = state

  const handleClick = useCallback(() => {
    void quitAndInstall().catch((err) => log.error('restart to install failed', err))
  }, [quitAndInstall])

  if (status !== 'downloaded') {
    return null
  }

  const label = t('phaseF.componentsAppSidebar.updateRestart')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleClick}
          aria-label={label}
          title={label}
          className={cn(
            'relative mb-1 flex h-8 w-full items-center justify-center gap-2 overflow-hidden rounded',
            'bg-sidebar-terracotta text-white shadow-sm transition-colors',
            'hover:bg-sidebar-terracotta/90 disabled:cursor-default',
            // collapsed (icon-only) sidebar: shrink to a square, drop the label
            'group-data-[collapsible=icon]:size-7 group-data-[collapsible=icon]:w-7 group-data-[collapsible=icon]:gap-0'
          )}
        >
          <RotateCw className="relative size-4 shrink-0" />
          <span className="relative text-xs font-medium group-data-[collapsible=icon]:hidden">
            {label}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
