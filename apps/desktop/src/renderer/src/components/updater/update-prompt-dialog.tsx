import { useCallback, useState } from 'react'
import type { AppUpdateState, UpdaterStatus } from '@memry/contracts/ipc-updater'
import { useT } from '@memry/i18n/renderer'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Download, RotateCw } from '@/lib/icons'
import { useAppUpdater } from '@/hooks/use-app-updater'
import { createLogger } from '@/lib/logger'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import memryLogo from '@/assets/icon-logo.png'

const log = createLogger('Component:UpdatePromptDialog')

/**
 * Whether the in-app update prompt should surface. With auto-download on, BOTH the
 * "available" and "downloaded" phases stay silent — the update downloads and installs
 * on the next quit without any popup — so a silent background update never flashes a
 * prompt when a new release is found on the short-interval poll.
 */
export function shouldShowUpdatePrompt(
  state: AppUpdateState,
  dismissedStatus: UpdaterStatus | null
): boolean {
  const isPromptable = state.status === 'available' || state.status === 'downloaded'
  return (
    state.updateSupported &&
    isPromptable &&
    state.status !== dismissedStatus &&
    !state.autoDownloadEnabled
  )
}

/**
 * In-app replacement for the native "update available" / "restart to install"
 * OS dialogs. Reads the shared updater state and surfaces two phases:
 *   available  → icon · version diff · release notes · auto-update checkbox
 *                · Skip This Version / Remind Me Later / Download
 *   downloaded → Restart Now / Later
 *
 * "Download" hands off to the sidebar update button for progress (the modal
 * closes as soon as the status leaves 'available'). "Remind Me Later" / "Later"
 * dismiss only the current phase for this session; a new phase (or next launch)
 * re-surfaces it. When auto-update is on, both phases stay silent — updates flow
 * straight through and install on the next natural quit.
 */
export function UpdatePromptDialog(): React.JSX.Element | null {
  const { t } = useT('common')
  const { state, downloadUpdate, quitAndInstall, skipVersion, setAutoDownload } = useAppUpdater()
  const [dismissedStatus, setDismissedStatus] = useState<UpdaterStatus | null>(null)
  const [busy, setBusy] = useState(false)

  const isAvailable = state.status === 'available'
  const isDownloaded = state.status === 'downloaded'

  const shouldShow = shouldShowUpdatePrompt(state, dismissedStatus)

  const dismiss = useCallback(() => {
    setDismissedStatus(state.status)
  }, [state.status])

  const handleDownload = useCallback(() => {
    setBusy(true)
    void downloadUpdate()
      .catch((err) => {
        log.error('update download failed', err)
        trackRendererError('update_download', err)
      })
      .finally(() => setBusy(false))
  }, [downloadUpdate])

  const handleSkip = useCallback(() => {
    if (!state.availableVersion) return
    setBusy(true)
    void skipVersion(state.availableVersion)
      .catch((err) => log.error('skip version failed', err))
      .finally(() => setBusy(false))
  }, [skipVersion, state.availableVersion])

  const handleRestart = useCallback(() => {
    setBusy(true)
    void quitAndInstall().catch((err) => {
      log.error('restart to install failed', err)
      trackRendererError('update_install', err)
      setBusy(false)
    })
  }, [quitAndInstall])

  const handleAutoDownloadChange = useCallback(
    (checked: boolean) => {
      void setAutoDownload(checked).catch((err) => log.error('set auto-download failed', err))
    },
    [setAutoDownload]
  )

  if (!shouldShow) return null

  const title = isDownloaded ? t('updatePrompt.downloadedTitle') : t('updatePrompt.availableTitle')
  const body = isDownloaded
    ? t('updatePrompt.downloadedBody', { version: state.availableVersion ?? '' })
    : t('updatePrompt.availableBody', {
        version: state.availableVersion ?? '',
        current: state.currentVersion
      })

  return (
    <Dialog
      open={shouldShow}
      onOpenChange={(open) => {
        if (!open) dismiss()
      }}
    >
      <DialogContent className="max-w-lg">
        <div className="flex items-start gap-4">
          <img src={memryLogo} alt="" className="size-12 shrink-0" />
          <div className="flex flex-col gap-1.5 pe-6">
            <DialogTitle className="text-base">{title}</DialogTitle>
            <DialogDescription>{body}</DialogDescription>
          </div>
        </div>

        {state.releaseNotes && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">
              {t('updatePrompt.releaseNotesLabel')}
            </p>
            <div className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-sm leading-relaxed text-foreground">
              {state.releaseNotes}
            </div>
          </div>
        )}

        {isAvailable && (
          <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={state.autoDownloadEnabled}
              onCheckedChange={(checked) => handleAutoDownloadChange(checked === true)}
            />
            {t('updatePrompt.autoUpdateLabel')}
          </label>
        )}

        {isDownloaded ? (
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={dismiss} disabled={busy}>
              {t('updatePrompt.later')}
            </Button>
            <Button size="sm" onClick={handleRestart} disabled={busy}>
              <RotateCw className="size-4" />
              {t('updatePrompt.restartNow')}
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={handleSkip} disabled={busy}>
              {t('updatePrompt.skip')}
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={dismiss} disabled={busy}>
                {t('updatePrompt.remindLater')}
              </Button>
              <Button size="sm" onClick={handleDownload} disabled={busy}>
                <Download className="size-4" />
                {t('updatePrompt.download')}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
