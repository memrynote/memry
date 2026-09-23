import { app, BrowserWindow, dialog } from 'electron'
import { getMainI18n } from '../lib/main-i18n'

export async function showPairConsentDialog(origin: string): Promise<boolean> {
  const mainWindow = BrowserWindow.getAllWindows()[0]
  if (!mainWindow) return false
  if (mainWindow.isMinimized()) mainWindow.restore()
  // The request comes from the browser, which stays frontmost. The dialog is a
  // sheet on this window, so a hidden window or a background app hides it and
  // the pairing silently times out.
  if (!mainWindow.isVisible()) mainWindow.show()
  if (process.platform === 'darwin') app.focus({ steal: true })
  mainWindow.focus()
  const t = getMainI18n().getFixedT(null, 'system')
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: [t('dialog.pair.buttonAllow'), t('dialog.pair.buttonDeny')],
    defaultId: 0,
    cancelId: 1,
    title: t('dialog.pair.title'),
    message: t('dialog.pair.message'),
    detail: origin
  })
  return response === 0
}
