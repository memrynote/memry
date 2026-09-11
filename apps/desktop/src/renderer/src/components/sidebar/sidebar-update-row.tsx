import { useCallback, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { cn } from '@/lib/utils'
import { useAppUpdater } from '@/hooks/use-app-updater'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import { toUpdatePresentation } from '@/components/updater/update-presentation'
import { UpdatePopover } from '@/components/updater/update-popover'
import { reopenInstallFailed } from '@/components/updater/install-failed-dismissal'
import { createLogger } from '@/lib/logger'

const log = createLogger('Component:SidebarUpdateRow')

const ROW =
  'flex h-7 w-full items-center gap-1.5 rounded-[5px] ps-1 pe-2.5 text-[13px] leading-4 font-medium text-sidebar-foreground'

/** The 16px lane that lines the status dot up with every nav row's icon. */
function StatusDot({ tone, dim }: { tone: 'tint' | 'destructive'; dim?: boolean }) {
  return (
    <span className="flex w-4 shrink-0 items-center justify-center" aria-hidden="true">
      <span
        className={cn(
          'size-1.5 rounded-full',
          tone === 'destructive' ? 'bg-destructive' : 'bg-[var(--tint)]',
          dim && 'opacity-45'
        )}
      />
    </span>
  )
}

/**
 * One quiet 28px row in the sidebar footer, sized and spaced like the nav rows
 * above it so the status dot lands in the same 16px icon lane. It states what is
 * happening and nothing more. The decision lives in the popover, which opens only
 * when the user clicks the row.
 */
export function SidebarUpdateRow(): React.JSX.Element | null {
  const { t } = useT('common')
  const { state, downloadUpdate, quitAndInstall } = useAppUpdater()
  const [open, setOpen] = useState(false)

  const presentation = toUpdatePresentation(state)

  const handleDownload = useCallback(() => {
    void downloadUpdate().catch((err) => log.error('update download failed', err))
  }, [downloadUpdate])

  const handleRestart = useCallback(() => {
    void quitAndInstall().catch((err) => log.error('restart to install failed', err))
  }, [quitAndInstall])

  if (presentation.kind === 'hidden' || presentation.kind === 'installing') return null

  if (presentation.kind === 'downloading') {
    const label = t('update.downloading', { version: presentation.version })
    return (
      <div className={cn('relative mb-1 overflow-hidden', ROW)} title={label}>
        <StatusDot tone="tint" dim />
        <span className="truncate text-start group-data-[collapsible=icon]:hidden">{label}</span>
        {presentation.percent != null && (
          <span
            aria-hidden="true"
            className="absolute bottom-0 start-0 h-0.5 bg-[var(--tint)] transition-[width] duration-300 motion-reduce:transition-none"
            style={{ width: `${presentation.percent}%` }}
          />
        )}
      </div>
    )
  }

  const isFailed = presentation.kind === 'failed'
  const label = isFailed
    ? t('update.failed')
    : presentation.kind === 'available'
      ? t('update.available')
      : t('update.ready')
  const verb = isFailed
    ? t('update.detailsAction')
    : presentation.kind === 'available'
      ? t('update.downloadAction')
      : t('update.restartAction')

  const rowButton = (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={isFailed ? reopenInstallFailed : undefined}
      className={cn(
        ROW,
        'absolute inset-0 hover:bg-sidebar-accent transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tint-ring)]'
      )}
    >
      <StatusDot tone={isFailed ? 'destructive' : 'tint'} />
      <span className="truncate text-start group-data-[collapsible=icon]:hidden">{label}</span>
    </button>
  )

  const trailing = (
    // A single grid cell holding both the resting version and the hover verb, so
    // swapping between them cannot reflow the row.
    <div className="pointer-events-none absolute inset-y-0 end-2.5 grid items-center group-data-[collapsible=icon]:hidden">
      {!isFailed && (
        <span className="[grid-area:1/1] justify-self-end font-mono text-[11px] text-text-tertiary group-hover/update:invisible group-focus-within/update:invisible">
          {presentation.version}
        </span>
      )}
      <button
        type="button"
        // The row itself is the popover trigger, so a verb click has to stop here.
        // Without this it both acts and opens the popover it is meant to skip.
        onClick={(event) => {
          event.stopPropagation()
          if (isFailed) reopenInstallFailed()
          else if (presentation.kind === 'available') handleDownload()
          else handleRestart()
        }}
        className={cn(
          '[grid-area:1/1] justify-self-end pointer-events-auto rounded text-[11px] font-medium',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tint-ring)]',
          isFailed
            ? 'text-destructive'
            : 'invisible text-[var(--tint)] group-hover/update:visible group-focus-within/update:visible'
        )}
      >
        {verb}
      </button>
    </div>
  )

  const row = (
    <div className="group/update relative mb-1 h-7">
      {rowButton}
      {trailing}
    </div>
  )

  // A failed install has no popover; "Details" reopens the blocking recovery dialog,
  // which is the one update moment that earns taking the window.
  if (isFailed) return row

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{row}</PopoverTrigger>
      <UpdatePopover
        kind={presentation.kind}
        version={presentation.version}
        state={state}
        onClose={() => setOpen(false)}
      />
    </Popover>
  )
}
