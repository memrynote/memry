import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useT } from '@memry/i18n/renderer'

interface ApplyTemplateConfirmDialogProps {
  isOpen: boolean
  templateName: string
  onCancel: () => void
  onConfirm: (mode: 'full' | 'body') => void
}

export function ApplyTemplateConfirmDialog({
  isOpen,
  templateName,
  onCancel,
  onConfirm
}: ApplyTemplateConfirmDialogProps) {
  const { t } = useT('notes')

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{t('applyTemplateConfirm.title')}</DialogTitle>
          <DialogDescription>
            {t('applyTemplateConfirm.description', { name: templateName })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-col gap-2 sm:flex-col sm:items-stretch">
          <Button onClick={() => onConfirm('full')}>{t('applyTemplateConfirm.full')}</Button>
          <Button variant="outline" onClick={() => onConfirm('body')}>
            {t('applyTemplateConfirm.body')}
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            {t('applyTemplateConfirm.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default ApplyTemplateConfirmDialog
