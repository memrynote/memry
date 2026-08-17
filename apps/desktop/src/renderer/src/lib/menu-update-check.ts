import { toast } from 'sonner'
import { getI18n } from 'react-i18next'
import { extractErrorMessage } from '@/lib/ipc-error'

/**
 * Menu-bar "Check for Updates…" (macOS app menu, Help menu on Windows/Linux).
 *
 * Runs the same check as the Settings button and always reports the outcome as a
 * toast. An available or downloaded update also raises `UpdatePromptDialog` from
 * the broadcast state, but that prompt stays silent when auto-download is on or
 * the user dismissed it this session — the toast is what keeps an explicit menu
 * click from looking dead.
 */
export async function runMenuUpdateCheck(): Promise<void> {
  const t = getI18n().getFixedT(null, 'settings')

  try {
    const state = await window.api.updater.checkForUpdates()

    if (!state.updateSupported) {
      toast.info(t('general.updates.unsupportedToast'))
      return
    }

    const version = state.availableVersion ?? ''

    switch (state.status) {
      case 'available':
        toast.info(t('general.updates.available', { version }))
        break
      case 'downloading':
        toast.info(t('general.updates.downloadingLatest'))
        break
      case 'downloaded':
        toast.info(t('general.updates.downloaded', { version }))
        break
      case 'error':
        toast.error(state.error ?? t('general.updates.actionFailed'))
        break
      // The check resolves only once it settles, so anything else means there is
      // no newer release to offer.
      default:
        toast.success(t('general.updates.upToDateToast', { version: state.currentVersion }))
    }
  } catch (err) {
    toast.error(extractErrorMessage(err, t('general.updates.actionFailed')))
  }
}
