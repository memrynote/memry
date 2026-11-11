/**
 * The review of the notes kept after their files were deleted outside the app (#4140), opened
 * from the `keptRemovals` notice's toast. Each note can have its file restored from the text
 * Memry kept, or be deleted on every device, its text to the OS trash first. Where the trash
 * refuses that text the user is asked before it goes for good (#3813). A note leaves the list as
 * its notice drops it, and the review closes once none is left.
 *
 * @module components/kept-removals-dialog
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import type { KeptRemoval } from '../../../generated/bindings'
import { commands } from '../../../generated/bindings'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { commandErrorCode, extractErrorMessage } from '@/lib/ipc-error'
import { isReviewOpen, keptName, setReviewOpen, subscribe } from '@/lib/kept-removals-review'
import { createLogger } from '@/lib/logger'
import { askPermanentDelete } from '@/lib/permanent-delete-question'
import { onVaultNotices } from '@/services/vault-service'

const log = createLogger('KeptRemovals')

export function KeptRemovalsDialog(): React.JSX.Element {
  const { t } = useT('common')
  const { t: tNotes } = useT('notes')
  const open = useSyncExternalStore(subscribe, isReviewOpen)
  const [kept, setKept] = useState<{ notes: KeptRemoval[]; more: boolean } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return undefined
    return onVaultNotices(({ notices }) => {
      const notice = notices.find((n) => n.kind === 'keptRemovals')
      if (!notice) {
        setReviewOpen(false)
        return
      }
      setKept({ notes: notice.notes, more: notice.more })
    })
  }, [open])

  const failed = (what: string, error: unknown): void => {
    log.error(`a kept note could not be ${what}`, error)
    toast.error(extractErrorMessage(error, t('vaultNotice.keptActionFailed')))
  }

  const restore = async (note: KeptRemoval): Promise<void> => {
    setBusy(note.noteId)
    try {
      await commands.vaultNoticesRestoreKept(note.noteId)
      toast.success(t('vaultNotice.keptRestored'))
    } catch (error) {
      failed('restored', error)
    } finally {
      setBusy(null)
    }
  }

  const remove = async (note: KeptRemoval): Promise<void> => {
    setConfirming(null)
    setBusy(note.noteId)
    try {
      try {
        await commands.vaultNoticesDeleteKept(note.noteId, null)
      } catch (error) {
        if (commandErrorCode(error) !== 'note_trash_unavailable') throw error
        // The trash refused the kept text (#3813): the user decides.
        if (!(await askPermanentDelete(note.noteId, keptName(note.path)))) {
          toast(tNotes('trashUnavailable.kept'))
          return
        }
        await commands.vaultNoticesDeleteKept(note.noteId, true)
      }
      toast.success(t('vaultNotice.keptDeleted'))
    } catch (error) {
      failed('deleted', error)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setReviewOpen}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('vaultNotice.keptReviewTitle')}</DialogTitle>
          <DialogDescription>{t('vaultNotice.keptReviewHint')}</DialogDescription>
        </DialogHeader>
        <ul className="max-h-80 space-y-2 overflow-y-auto">
          {kept?.notes.map((note) => (
            <li key={note.noteId} className="rounded-md border px-3 py-2">
              <div className="flex items-center gap-2">
                <bdi className="min-w-0 flex-1 truncate text-sm font-medium">
                  {keptName(note.path)}
                </bdi>
                {confirming === note.noteId ? (
                  <>
                    <Button variant="outline" size="sm" onClick={() => setConfirming(null)}>
                      {t('button.cancel')}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => void remove(note)}
                    >
                      {t('button.delete')}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => void restore(note)}
                    >
                      {t('vaultNotice.keptRestore')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      disabled={busy !== null}
                      onClick={() => setConfirming(note.noteId)}
                    >
                      {t('vaultNotice.keptDelete')}
                    </Button>
                  </>
                )}
              </div>
              {confirming === note.noteId && (
                <p className="mt-1 text-start text-xs text-muted-foreground">
                  {t('vaultNotice.keptDeleteConfirm')}
                </p>
              )}
            </li>
          ))}
        </ul>
        {kept?.more && (
          <p className="text-start text-xs text-muted-foreground">
            {t('vaultNotice.moreUnlisted')}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
