import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useSettingsModal } from '@/contexts/settings-modal-context'
import { SettingsPage } from '@/pages/settings'
import { getSettingsParent } from '@/pages/settings/settings-navigation'
import { useT } from '@memry/i18n/renderer'

export function SettingsModal() {
  const { isOpen, close, activeSection, setActiveSection } = useSettingsModal()
  const { t } = useT('settings')

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent
        className="max-w-[76rem] h-[80vh] p-0 gap-0 overflow-hidden flex flex-col"
        onEscapeKeyDown={(event) => {
          // Escape in a non-empty settings search clears the query first.
          const target = event.target
          if (
            target instanceof HTMLInputElement &&
            target.hasAttribute('data-settings-search') &&
            target.value
          ) {
            event.preventDefault()
            return
          }
          // In a drill-in sub-page, Escape steps back instead of closing settings.
          const parent = getSettingsParent(activeSection)
          if (parent) {
            event.preventDefault()
            setActiveSection(parent)
          }
        }}
      >
        <DialogTitle className="sr-only">{t('page.title')}</DialogTitle>
        <SettingsPage />
      </DialogContent>
    </Dialog>
  )
}
