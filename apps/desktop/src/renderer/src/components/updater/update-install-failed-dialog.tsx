import { useCallback, useState } from 'react'
import type { AppUpdateState } from '@memry/contracts/ipc-updater'
import { useT } from '@memry/i18n/renderer'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Download } from '@/lib/icons'
import { useAppUpdater } from '@/hooks/use-app-updater'
import memryLogo from '@/assets/icon-logo.png'

const DOWNLOAD_URL = 'https://memrynote.com/download'

/**
 * Only surfaces for an install that was attempted and never applied — the flag is
 * set once per launch from the update-install marker and cleared with it, so this
 * can neither fire on a normal launch nor repeat after the update succeeds.
 */
export function shouldShowInstallFailedPrompt(state: AppUpdateState, dismissed: boolean): boolean {
  return state.updateSupported && !dismissed && Boolean(state.installFailed)
}

/**
 * Recovery prompt for an update that downloaded, restarted the app, and then
 * silently failed to install. Before this the failure was invisible: the same
 * update prompt returned on the next launch, Restart did the same nothing, and
 * the user's only way out was to work out on their own that uninstalling and
 * reinstalling was the way to move versions.
 *
 * Deliberately not blocking — the app works, it is just the wrong version — and
 * dismissible for the session. The marker is consumed on the launch that reads
 * it, so a successful update never shows this again.
 */
export function UpdateInstallFailedDialog(): React.JSX.Element | null {
  const { t } = useT('common')
  const { state } = useAppUpdater()
  const [dismissed, setDismissed] = useState(false)

  const handleDownload = useCallback(() => {
    // Routed to the OS browser by the main-process openExternal allowlist.
    window.open(DOWNLOAD_URL, '_blank', 'noopener,noreferrer')
    setDismissed(true)
  }, [])

  if (!shouldShowInstallFailedPrompt(state, dismissed)) return null

  const failedVersion = state.installFailed?.version ?? null
  const body = failedVersion
    ? t('updatePrompt.installFailedBody', {
        version: failedVersion,
        current: state.currentVersion
      })
    : t('updatePrompt.installFailedBodyUnknownVersion', { current: state.currentVersion })

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) setDismissed(true)
      }}
    >
      <DialogContent className="max-w-lg">
        <div className="flex items-start gap-4">
          <img src={memryLogo} alt="" className="size-12 shrink-0" />
          <div className="flex flex-col gap-1.5 pe-6">
            <DialogTitle className="text-base">{t('updatePrompt.installFailedTitle')}</DialogTitle>
            <DialogDescription>{body}</DialogDescription>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={() => setDismissed(true)}>
            {t('updatePrompt.later')}
          </Button>
          <Button size="sm" onClick={handleDownload}>
            <Download className="size-4" />
            {t('updatePrompt.downloadInstaller')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
