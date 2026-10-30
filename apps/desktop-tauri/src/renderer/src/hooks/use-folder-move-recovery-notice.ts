/**
 * Says what the vault open did with a folder move a crash interrupted (#3754): put back where
 * it was, or, for a move it has no record of, only made visible again. Notes that could not
 * go back under their own name are in sight under a suffix the notice names.
 *
 * The open's status holds the notice until the vault closes, and the status is read once this
 * subscribes, so a shell that mounts after the open (after onboarding, say) still shows it.
 * Each open's notice has its own id and shows once.
 */

import { useEffect } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { onVaultStatusChanged } from '@/services/vault-service'

/** The suffixes the Rust move code gives folders and notes on disk; they are never translated. */
const CONFLICT_COPY = '(conflict copy)'
const INCOMPLETE_MOVE = '(incomplete move)'

const shown = new Set<string>()

/** Listens for swept folder moves. Should be used once in the vault shell. */
export function useFolderMoveRecoveryNotice(): void {
  const { t } = useT('common')

  useEffect(() => {
    return onVaultStatusChanged(({ movesRecovered: notice }) => {
      if (!notice || shown.has(notice.id)) return
      shown.add(notice.id)
      const description = [
        notice.undone > 0 && t('toast.folderMoveUndoneHint'),
        notice.conflictCopies > 0 && t('toast.folderMoveConflictCopies', { suffix: CONFLICT_COPY }),
        notice.keptFolders + notice.shownFolders > 0 &&
          t('toast.folderMoveIncomplete', { suffix: INCOMPLETE_MOVE }),
        t('toast.folderMoveNothingDeleted')
      ]
        .filter(Boolean)
        .join(' ')
      toast(t(notice.undone > 0 ? 'toast.folderMoveUndone' : 'toast.folderMoveShown'), {
        description,
        duration: Infinity,
        closeButton: true
      })
    })
  }, [t])
}
