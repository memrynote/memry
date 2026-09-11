import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { cn } from '@/lib/utils'
import { useAppUpdater } from '@/hooks/use-app-updater'
import { Popover, PopoverAnchor } from '@/components/ui/popover'
import { toUpdatePresentation } from '@/components/updater/update-presentation'
import { UpdatePopover } from '@/components/updater/update-popover'
import { reopenInstallFailed } from '@/components/updater/install-failed-dismissal'
import { createLogger } from '@/lib/logger'

const log = createLogger('Component:SidebarUpdateRow')

/**
 * Long enough that crossing the row on the way to Settings does not open anything,
 * short enough that aiming at it feels immediate.
 */
const HOVER_OPEN_MS = 400
/** Covers the gap between the row and the panel, so the trip there does not close it. */
const HOVER_CLOSE_MS = 180

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
 * happening and nothing more. The decision lives in the popover, which opens on a
 * click or on a deliberate hover.
 */
export function SidebarUpdateRow(): React.JSX.Element | null {
  const { t } = useT('common')
  const { state, downloadUpdate, quitAndInstall } = useAppUpdater()
  const [open, setOpen] = useState(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const presentation = toUpdatePresentation(state)

  const cancelHover = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = null
  }, [])

  const scheduleOpen = useCallback(
    (next: boolean) => {
      cancelHover()
      hoverTimer.current = setTimeout(() => setOpen(next), next ? HOVER_OPEN_MS : HOVER_CLOSE_MS)
    },
    [cancelHover]
  )

  useEffect(() => cancelHover, [cancelHover])

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
      onClick={
        isFailed
          ? reopenInstallFailed
          : () => {
              cancelHover()
              setOpen((wasOpen) => !wasOpen)
            }
      }
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
        // Sibling of the row button, not nested in it, so acting here never reaches
        // the row's own toggle. The popover stays shut.
        onClick={() => {
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
    <div
      className="group/update relative mb-1 h-7"
      onMouseEnter={isFailed ? undefined : () => scheduleOpen(true)}
      onMouseLeave={isFailed ? undefined : () => scheduleOpen(false)}
    >
      {rowButton}
      {trailing}
    </div>
  )

  // A failed install has no popover; "Details" reopens the blocking recovery dialog,
  // which is the one update moment that earns taking the window.
  if (isFailed) return row

  return (
    // Anchor rather than trigger: the row owns `open` so that hover and click agree.
    // A trigger would toggle on its own and fight the hover timers.
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>{row}</PopoverAnchor>
      <UpdatePopover
        kind={presentation.kind}
        version={presentation.version}
        state={state}
        onClose={() => setOpen(false)}
        onMouseEnter={cancelHover}
        onMouseLeave={() => scheduleOpen(false)}
      />
    </Popover>
  )
}
