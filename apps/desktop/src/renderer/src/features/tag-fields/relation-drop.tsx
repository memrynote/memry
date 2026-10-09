import { useState } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import type { TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'
import { notesService } from '@/services/notes-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { MEMRY_NOTE_DRAG_MIME } from '@/lib/drag-mime'
import { noteRelationUri } from '@/lib/graph-edits'
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

export function isObjectOfTarget(
  headerTags: readonly string[],
  target: string,
  snapshot: TagSchemaSnapshot | undefined
): boolean {
  const key = target.toLowerCase()
  return headerTags.some((name) => {
    const tag = name.trim().toLowerCase()
    return tag === key || (snapshot?.tags[tag]?.ancestors.includes(key) ?? false)
  })
}

interface PendingDrop {
  noteId: string
  title: string
}

export function useRelationDrop({
  targetTag,
  snapshot,
  onLink
}: {
  targetTag: string | null | undefined
  snapshot: TagSchemaSnapshot | undefined
  onLink: (uri: string) => void
}): {
  dropProps: React.HTMLAttributes<HTMLElement>
  isOver: boolean
  dialog: React.ReactNode
} {
  const { t } = useT('notes')
  const [isOver, setIsOver] = useState(false)
  const [pending, setPending] = useState<PendingDrop | null>(null)
  const targetName = targetTag ? (snapshot?.tags[targetTag]?.name ?? targetTag) : ''

  const accepts = (event: React.DragEvent): boolean =>
    !!targetTag && event.dataTransfer.types.includes(MEMRY_NOTE_DRAG_MIME)

  const handleDrop = async (noteId: string): Promise<void> => {
    if (!targetTag) return
    try {
      const note = await notesService.get(noteId)
      if (!note) {
        toast.error(t('tagObjects.relationDrop.notANote', { tag: targetName }))
        return
      }
      if (isObjectOfTarget(note.headerTags, targetTag, snapshot)) {
        onLink(noteRelationUri(note.id))
        return
      }
      setPending({ noteId: note.id, title: note.title })
    } catch (error) {
      toast.error(extractErrorMessage(error, t('tagObjects.relationDrop.failed')))
    }
  }

  const confirm = async (): Promise<void> => {
    if (!pending || !targetTag) return
    const { noteId, title } = pending
    setPending(null)
    try {
      const result = await notesService.update({
        id: noteId,
        headerTags: { add: [targetName] }
      })
      if (!result.success) throw new Error(result.error)
      onLink(noteRelationUri(noteId))
      toast.success(t('tagObjects.relationDrop.added', { title, tag: targetName }))
    } catch (error) {
      toast.error(extractErrorMessage(error, t('tagObjects.relationDrop.failed')))
    }
  }

  const dropProps: React.HTMLAttributes<HTMLElement> = {
    onDragOver: (event) => {
      if (!accepts(event)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'link'
      setIsOver(true)
    },
    onDragLeave: () => setIsOver(false),
    onDrop: (event) => {
      if (!accepts(event)) return
      event.preventDefault()
      event.stopPropagation()
      setIsOver(false)
      const noteId = event.dataTransfer.getData(MEMRY_NOTE_DRAG_MIME)
      if (noteId) void handleDrop(noteId)
    }
  }

  const dialog = (
    <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('tagObjects.relationDrop.title', { title: pending?.title ?? '', tag: targetName })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('tagObjects.relationDrop.body', { title: pending?.title ?? '', tag: targetName })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('tagObjects.relationDrop.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={() => void confirm()}>
            {t('tagObjects.relationDrop.confirm', { tag: targetName })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  return { dropProps, isOver, dialog }
}
