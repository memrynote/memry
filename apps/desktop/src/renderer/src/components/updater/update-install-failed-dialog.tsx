import { useCallback } from 'react'
import type { AppUpdateState } from '@memry/contracts/ipc-updater'
import { useT } from '@memry/i18n/renderer'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Download } from '@/lib/icons'
import { useAppUpdater } from '@/hooks/use-app-updater'
import { createLogger } from '@/lib/logger'
import { dismissInstallFailed, useInstallFailedDismissed } from './install-failed-dismissal'

const log = createLogger('Component:UpdateInstallFailedDialog')

const DOWNLOAD_URL = 'https://memrynote.com/download/desktop'

/**
 * Only surfaces for an install that was attempted and never applied — the flag is
 * set once per launch from the update-install marker and cleared with it, so this
 * can neither fire on a normal launch nor repeat after the update succeeds.
 */
export function shouldShowInstallFailedPrompt(state: AppUpdateState, dismissed: boolean): boolean {
  return state.updateSupported && !dismissed && Boolean(state.installFailed)
}

/**
 * The one update moment that earns taking the window: a half-written install left
 * the app on a version the user did not choose. Everything else in the update flow
 * is a quiet sidebar row, but a failed install needs an answer, and the first thing
 * it has to say is that the vault is untouched.
 *
 * Dismissible for the session; the sidebar row's "Details" brings it back. The
 * marker is consumed on the launch that reads it, so a successful update never
 * shows this again.
 */
export function UpdateInstallFailedDialog(): React.JSX.Element | null {
  const { t } = useT('common')
  const { state, checkForUpdates } = useAppUpdater()
  const dismissed = useInstallFailedDismissed()

  const failedVersion = state.installFailed?.version ?? null

  const handleDownload = useCallback(() => {
    // Routed to the OS browser by the main-process openExternal allowlist.
    window.open(DOWNLOAD_URL, '_blank', 'noopener,noreferrer')
    dismissInstallFailed()
  }, [])

  const handleTryAgain = useCallback(() => {
    dismissInstallFailed()
    void checkForUpdates().catch((err) => log.error('re-check after failed install failed', err))
  }, [checkForUpdates])

  const handleCopyDetails = useCallback(() => {
    void navigator.clipboard
      .writeText(
        [
          `MemryNote ${state.currentVersion}`,
          `failed to install: ${failedVersion ?? 'unknown version'}`,
          state.error ?? ''
        ]
          .filter(Boolean)
          .join('\n')
      )
      .catch((err) => log.error('copy install failure details failed', err))
  }, [state.currentVersion, state.error, failedVersion])

  if (!shouldShowInstallFailedPrompt(state, dismissed)) return null

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismissInstallFailed()
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogTitle className="text-base">
          {failedVersion
            ? t('update.installFailed.title', { version: failedVersion })
            : t('update.installFailed.titleUnknownVersion')}
        </DialogTitle>
        <DialogDescription>
          {t('update.installFailed.body', { current: state.currentVersion })}
        </DialogDescription>

        {state.error && (
          <div>
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-text-tertiary">
              {t('update.installFailed.errorLabel')}
            </p>
            <pre className="max-h-40 overflow-auto rounded-md border bg-surface p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-text-secondary">
              {state.error}
            </pre>
          </div>
        )}

        <div className="flex items-center gap-2 pt-1">
          <Button
            size="sm"
            onClick={handleDownload}
            // Ink, not tint: this is recovery, and the tint fill is reserved for
            // creation and commit moments.
            className="bg-foreground text-background hover:bg-foreground/90"
          >
            <Download className="size-4" />
            {failedVersion
              ? t('update.installFailed.downloadManually', { version: failedVersion })
              : t('update.installFailed.downloadManuallyUnknownVersion')}
          </Button>
          <Button variant="outline" size="sm" onClick={handleTryAgain}>
            {t('update.installFailed.tryAgain')}
          </Button>
          <Button variant="ghost" size="sm" onClick={handleCopyDetails} disabled={!state.error}>
            {t('update.installFailed.copyDetails')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
