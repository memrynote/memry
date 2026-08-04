/**
 * Unsaved Changes Dialog
 * Confirmation dialog for closing a tab with unsaved changes
 */

import { useT } from '@memry/i18n/renderer'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'

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
          {/* Plain buttons, not AlertDialogAction: that primitive is Dialog.Close
              and would fire onOpenChange(false) — read as Cancel — on top of the
              handler below, aborting the close it was meant to resolve. */}
          <Button onClick={onDiscard} className="bg-red-500 hover:bg-red-600">
            {t('button.dontSave')}
          </Button>
          {onSave && <Button onClick={onSave}>{t('button.save')}</Button>}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default UnsavedChangesDialog
