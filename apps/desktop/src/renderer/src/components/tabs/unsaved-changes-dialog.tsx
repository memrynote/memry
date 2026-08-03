/**
 * Unsaved Changes Dialog
 * Confirmation dialog for closing a tab with unsaved changes
 */

import { useT } from '@memry/i18n/renderer'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'

// =============================================================================
// DIALOG COMPONENT
// =============================================================================

interface UnsavedChangesDialogProps {
  /** Whether dialog is open */
  isOpen: boolean
  /** Tab title */
  tabTitle: string
  /** Save handler */
  onSave?: () => void
  /** Discard handler */
  onDiscard: () => void
  /** Cancel handler */
  onCancel: () => void
}

/**
 * Confirmation dialog for unsaved changes
 */
export const UnsavedChangesDialog = ({
  isOpen,
  tabTitle,
  onSave,
  onDiscard,
  onCancel
}: UnsavedChangesDialogProps): React.JSX.Element => {
  const { t: tPhaseF } = useT('common')
  const { t } = useT('common')
  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {tPhaseF('phaseF.componentsTabsUnsavedChangesDialog.unsavedChanges')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {tPhaseF('phaseF.componentsTabsUnsavedChangesDialog.unsavedChangesBody', {
              title: tabTitle
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>{t('button.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onDiscard} className="bg-red-500 hover:bg-red-600">
            {t('button.dontSave')}
          </AlertDialogAction>
          {onSave && <AlertDialogAction onClick={onSave}>{t('button.save')}</AlertDialogAction>}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default UnsavedChangesDialog
