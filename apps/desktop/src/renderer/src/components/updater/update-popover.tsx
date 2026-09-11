import { useCallback } from 'react'
import type { AppUpdateState } from '@memry/contracts/ipc-updater'
import { useT } from '@memry/i18n/renderer'
import { PopoverContent } from '@/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ArrowUpRight, MoreHorizontal } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useAppUpdater } from '@/hooks/use-app-updater'
import { createLogger } from '@/lib/logger'
import { trackRendererError } from '@/lib/telemetry-diagnostics'

const log = createLogger('Component:UpdatePopover')

const RELEASES_URL = 'https://github.com/memrynote/memry/releases/latest'

const LEADING_MARKER = /^\s*(?:[-*•·–]|\d+[.)])\s*/
const LEADING_EMOJI = /^[\p{Extended_Pictographic}️‍\s]+/u

/**
 * The first three lines of the release notes, stripped of list markers and the
 * leading emoji the feed decorates each bullet with. Three is the whole point: the
 * popover summarises, the release-notes tab is where the full body lives.
 */
export function parseHighlights(notes: string | null): string[] {
  if (!notes) return []
  return notes
    .split('\n')
    .map((line) => line.replace(LEADING_MARKER, '').replace(LEADING_EMOJI, '').trim())
    .filter((line) => line.length > 0)
    .slice(0, 3)
}

const TINT_BUTTON =
  'h-8 rounded-lg px-3 text-xs font-medium text-[var(--tint-foreground)] bg-[var(--tint)] hover:bg-[var(--tint-hover)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tint-ring)]'

const GHOST_BUTTON =
  'h-8 rounded-lg px-3 text-xs font-medium text-text-secondary hover:bg-surface-active transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tint-ring)]'

interface UpdatePopoverProps {
  /** Only `available` and `ready` reach here; the row renders nothing otherwise. */
  kind: 'available' | 'ready'
  version: string
  state: AppUpdateState
  onClose: () => void
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}

/**
 * Anchored replacement for the old full-window update modal. It exists only because
 * the user clicked the sidebar row, so it never interrupts: no timer, no re-prompt,
 * and "Not now" / "On next quit" close it and do nothing else.
 */
export function UpdatePopover({
  kind,
  version,
  state,
  onClose,
  onMouseEnter,
  onMouseLeave
}: UpdatePopoverProps): React.JSX.Element {
  const { t } = useT('common')
  const { downloadUpdate, quitAndInstall, skipVersion, setAutoDownload } = useAppUpdater()

  const highlights = parseHighlights(state.releaseNotes)

  const handleDownload = useCallback(() => {
    onClose()
    void downloadUpdate().catch((err) => {
      log.error('update download failed', err)
      trackRendererError('update_download', err)
    })
  }, [downloadUpdate, onClose])

  const handleRestart = useCallback(() => {
    onClose()
    void quitAndInstall().catch((err) => {
      log.error('restart to install failed', err)
      trackRendererError('update_install', err)
    })
  }, [quitAndInstall, onClose])

  const handleSkip = useCallback(() => {
    onClose()
    void skipVersion(version).catch((err) => log.error('skip version failed', err))
  }, [skipVersion, version, onClose])

  const handleTurnOffAuto = useCallback(() => {
    onClose()
    void setAutoDownload(false).catch((err) => log.error('set auto-download failed', err))
  }, [setAutoDownload, onClose])

  const handleCopyVersionInfo = useCallback(() => {
    onClose()
    void navigator.clipboard
      .writeText(`MemryNote ${state.currentVersion} → ${version}`)
      .catch((err) => log.error('copy version info failed', err))
  }, [state.currentVersion, version, onClose])

  const handleAllChanges = useCallback(() => {
    onClose()
    // Routed to the OS browser by the main-process openExternal allowlist. The full
    // changelog belongs on the release page, not in a tab the user has to close.
    window.open(RELEASES_URL, '_blank', 'noopener,noreferrer')
  }, [onClose])

  const isReady = kind === 'ready'

  return (
    <PopoverContent
      side="top"
      align="start"
      sideOffset={6}
      className="w-80 p-0"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      // Opening must not yank the caret out of the editor. Tab still reaches
      // everything inside, because only the initial autofocus is suppressed.
      onOpenAutoFocus={(event) => event.preventDefault()}
    >
      <div className="p-3.5">
        <p className="text-[13px] font-semibold text-text-primary">
          {isReady
            ? t('update.popover.readyTitle', { version })
            : t('update.popover.availableTitle', { version })}
        </p>
        <p className="mt-0.5 text-xs text-text-secondary">
          {isReady
            ? t('update.popover.readySubtitle', { current: state.currentVersion })
            : t('update.popover.availableSubtitle', { current: state.currentVersion })}
        </p>
      </div>

      {highlights.length > 0 && (
        <div className="border-t p-3.5">
          <ul className="flex flex-col gap-1.5">
            {highlights.map((highlight) => (
              <li key={highlight} className="flex gap-2 text-xs leading-5 text-text-secondary">
                <span aria-hidden="true" className="text-text-tertiary">
                  •
                </span>
                <span className="min-w-0">{highlight}</span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={handleAllChanges}
            className="mt-2.5 inline-flex items-center gap-1 text-xs font-medium text-text-secondary hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tint-ring)] rounded"
          >
            {t('update.popover.allChanges')}
            <ArrowUpRight className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      <div className="flex items-center gap-2 border-t bg-surface p-3.5">
        {isReady ? (
          <>
            <button type="button" onClick={handleRestart} className={TINT_BUTTON}>
              {t('update.popover.restartNow')}
            </button>
            <button type="button" onClick={onClose} className={GHOST_BUTTON}>
              {t('update.popover.onNextQuit')}
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={handleDownload} className={TINT_BUTTON}>
              {t('update.popover.download')}
            </button>
            <button type="button" onClick={onClose} className={GHOST_BUTTON}>
              {t('update.popover.notNow')}
            </button>
          </>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('update.popover.moreOptions')}
              className={cn(
                'ms-auto flex size-8 shrink-0 items-center justify-center rounded-lg',
                'text-text-tertiary hover:bg-surface-active hover:text-text-secondary transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tint-ring)]'
              )}
            >
              <MoreHorizontal className="size-4" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="text-xs">
            <DropdownMenuItem onSelect={handleSkip}>
              {t('update.popover.skipVersion', { version })}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={handleTurnOffAuto}>
              {t('update.popover.turnOffAuto')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={handleCopyVersionInfo}>
              {t('update.popover.copyVersionInfo')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </PopoverContent>
  )
}
