import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useSettingsModal } from '@/contexts/settings-modal-context'
import { SettingsPage } from '@/pages/settings'

export function SettingsModal() {
  const { isOpen, close } = useSettingsModal()

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-[76rem] h-[80vh] p-0 gap-0 overflow-hidden">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <SettingsPage />
      </DialogContent>
    </Dialog>
  )
}
