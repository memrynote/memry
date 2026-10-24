import { useT } from '@memry/i18n/renderer'
import { cn } from '@/lib/utils'
import { useAppUpdater } from '@/hooks/use-app-updater'
import { toUpdatePresentation } from '@/components/updater/update-presentation'
import { reopenInstallFailed } from '@/components/updater/install-failed-dismissal'

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
 * happening and nothing more: download progress, or a failed install whose
 * recovery dialog it reopens.
 */
export function SidebarUpdateRow(): React.JSX.Element | null {
  const { t } = useT('common')
  const { state } = useAppUpdater()
  const presentation = toUpdatePresentation(state)

  // Available and ready live on the footer-dock gear badge (SidebarSettingsButton).
  // This row stays for the two states that need width: download progress and
  // failed-install recovery.
  if (
    presentation.kind === 'hidden' ||
    presentation.kind === 'installing' ||
    presentation.kind === 'available' ||
    presentation.kind === 'ready'
  )
    return null

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

  // Only a failed install reaches here. It has no popover; "Details" reopens the
  // blocking recovery dialog, the one update moment that earns taking the window.
  const label = t('update.failed')
  return (
    <div className="group/update relative mb-1 h-7">
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={reopenInstallFailed}
        className={cn(
          ROW,
          'absolute inset-0 hover:bg-sidebar-accent transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tint-ring)]'
        )}
      >
        <StatusDot tone="destructive" />
        <span className="truncate text-start group-data-[collapsible=icon]:hidden">{label}</span>
      </button>
      <div className="pointer-events-none absolute inset-y-0 end-2.5 grid items-center group-data-[collapsible=icon]:hidden">
        <button
          type="button"
          onClick={reopenInstallFailed}
          className="pointer-events-auto rounded text-[11px] font-medium text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tint-ring)]"
        >
          {t('update.detailsAction')}
        </button>
      </div>
    </div>
  )
}
