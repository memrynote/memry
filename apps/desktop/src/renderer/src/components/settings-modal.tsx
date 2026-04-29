import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useSettingsModal } from '@/contexts/settings-modal-context'
import { SettingsPage } from '@/pages/settings'
import { useT } from '@memry/i18n/renderer'

export function SettingsModal() {
  const { isOpen, close } = useSettingsModal()
  const { t } = useT('settings')

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-[76rem] h-[80vh] p-0 gap-0 overflow-hidden flex flex-col">
        <DialogTitle className="sr-only">{t('page.title')}</DialogTitle>
        <SettingsPage />
      </DialogContent>
    </Dialog>
  )
}
