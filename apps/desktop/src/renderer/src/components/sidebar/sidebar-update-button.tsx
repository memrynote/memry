import { useCallback } from 'react'
import { Download, RotateCw } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'
import { useAppUpdater } from '@/hooks/use-app-updater'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { createLogger } from '@/lib/logger'

const log = createLogger('Component:SidebarUpdateButton')

/**
 * Accent button pinned above the sync/vault/settings row in the sidebar footer.
 * Mirrors the update lifecycle from the native popup:
 *   available  → "Update"  (click downloads)
 *   downloading → "Downloading {percent}%" (live, with a progress fill)
 *   downloaded → "Restart" (click quits + installs)
 * Hidden in every other state (idle / checking / up-to-date / unsupported / error).
 */
export function SidebarUpdateButton() {
  const { t } = useT('common')
  const { state, downloadUpdate, quitAndInstall } = useAppUpdater()
  const { status, downloadProgressPercent } = state

  const handleClick = useCallback(() => {
    if (status === 'available') {
      void downloadUpdate().catch((err) => log.error('update download failed', err))
    } else if (status === 'downloaded') {
      void quitAndInstall().catch((err) => log.error('restart to install failed', err))
    }
  }, [status, downloadUpdate, quitAndInstall])

  if (status !== 'available' && status !== 'downloading' && status !== 'downloaded') {
    return null
  }

  const isDownloading = status === 'downloading'
  const isDownloaded = status === 'downloaded'
  const percent = Math.max(0, Math.min(100, downloadProgressPercent ?? 0))

  const label = isDownloaded
    ? t('phaseF.componentsAppSidebar.updateRestart')
    : isDownloading
      ? downloadProgressPercent == null
        ? t('phaseF.componentsAppSidebar.updateDownloading')
        : t('phaseF.componentsAppSidebar.updateDownloadingPercent', { percent })
      : t('phaseF.componentsAppSidebar.updateAvailable')

  const Icon = isDownloaded ? RotateCw : Download

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleClick}
          disabled={isDownloading}
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
          {isDownloading && (
            <span
              aria-hidden="true"
              className="absolute inset-y-0 start-0 bg-white/25 transition-[width] duration-300"
              style={{ width: `${percent}%` }}
            />
          )}
          <Icon className={cn('relative size-4 shrink-0', isDownloading && 'animate-pulse')} />
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
