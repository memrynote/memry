import { useCallback, useState } from 'react'
import type { AppUpdateState, UpdaterStatus } from '@memry/contracts/ipc-updater'
import { useT } from '@memry/i18n/renderer'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { RotateCw } from '@/lib/icons'
import { useAppUpdater } from '@/hooks/use-app-updater'
import { createLogger } from '@/lib/logger'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import memryLogo from '@/assets/icon-logo.png'

const log = createLogger('Component:UpdatePromptDialog')

/**
 * Whether the in-app update prompt should surface. Updates download silently —
 * the 'available' and 'downloading' phases never show anything — so the ONLY
 * promptable phase is 'downloaded': the user is told a restart applies the
 * update, and nothing else. The release notes open as a tab after that restart,
 * not here (see update-release-notes-tab-opener).
 */
export function shouldShowUpdatePrompt(
  state: AppUpdateState,
  dismissedStatus: UpdaterStatus | null
): boolean {
  return state.updateSupported && state.status === 'downloaded' && dismissedStatus !== 'downloaded'
}

/**
 * In-app replacement for the native "restart to install" OS dialog. Surfaces
 * exactly one phase:
 *   downloaded → Restart Now / Later
 * "Later" dismisses for this session (the sidebar Restart button stays, and the
 * update still installs on the next natural quit via autoInstallOnAppQuit).
 */
export function UpdatePromptDialog(): React.JSX.Element | null {
  const { t } = useT('common')
  const { state, quitAndInstall } = useAppUpdater()
  const [dismissedStatus, setDismissedStatus] = useState<UpdaterStatus | null>(null)
  const [busy, setBusy] = useState(false)

  const shouldShow = shouldShowUpdatePrompt(state, dismissedStatus)

  const dismiss = useCallback(() => {
    setDismissedStatus(state.status)
  }, [state.status])

  const handleRestart = useCallback(() => {
    setBusy(true)
    void quitAndInstall().catch((err) => {
      log.error('restart to install failed', err)
      trackRendererError('update_install', err)
      setBusy(false)
    })
  }, [quitAndInstall])

  if (!shouldShow) return null

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
            <DialogTitle className="text-base">{t('updatePrompt.downloadedTitle')}</DialogTitle>
            <DialogDescription>
              {t('updatePrompt.downloadedBody', { version: state.availableVersion ?? '' })}
            </DialogDescription>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={dismiss} disabled={busy}>
            {t('updatePrompt.later')}
          </Button>
          <Button size="sm" onClick={handleRestart} disabled={busy}>
            <RotateCw className="size-4" />
            {t('updatePrompt.restartNow')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
