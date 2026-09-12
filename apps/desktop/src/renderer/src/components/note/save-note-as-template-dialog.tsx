import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTabs } from '@/contexts/tabs'
import { buildTemplateFromNote, MAX_TEMPLATE_NAME_LENGTH } from '@/lib/note-to-template'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { flushAllPendingSaves } from '@/lib/save-registry'
import { notesService } from '@/services/notes-service'
import { propertiesService } from '@/services/properties-service'
import { templatesService, type TemplateCreateInput } from '@/services/templates-service'
import { useT } from '@memry/i18n/renderer'

const log = createLogger('SaveNoteAsTemplate')

interface SaveNoteAsTemplateDialogProps {
  noteId: string | null
  isOpen: boolean
  onClose: () => void
}

export function SaveNoteAsTemplateDialog(props: SaveNoteAsTemplateDialogProps) {
  if (!props.isOpen) return null
  return <SaveNoteAsTemplateDialogActive {...props} />
}

function SaveNoteAsTemplateDialogActive({
  noteId,
  isOpen,
  onClose
}: SaveNoteAsTemplateDialogProps) {
  const { t } = useT('notes')
  const { openTab } = useTabs()
  const [source, setSource] = useState<TemplateCreateInput | null>(null)
  const [name, setName] = useState('')
  const loadStartedRef = useRef(false)
  const submittingRef = useRef(false)

  useEffect(() => {
    if (!noteId || loadStartedRef.current) return
    loadStartedRef.current = true
    void (async () => {
      try {
        // The note page debounces its body by a second, so an unflushed
        // sentence would be missing from the template.
        await flushAllPendingSaves()
        const [note, properties] = await Promise.all([
          notesService.get(noteId),
          propertiesService.get(noteId)
        ])
        if (!note) throw new Error(`note ${noteId} not found`)
        const built = buildTemplateFromNote({
          title: note.title,
          content: note.content,
          tags: note.tags,
          properties
        })
        setSource(built)
        setName(built.name)
      } catch (err) {
        log.error('failed to read the note', { err })
        toast.error(extractErrorMessage(err, t('saveNoteAsTemplate.loadFailed')))
        onClose()
      }
    })()
  }, [noteId, onClose, t])

  const trimmedName = name.trim()

  const submit = useCallback(async () => {
    if (!source || !trimmedName) return
    if (submittingRef.current) return
    submittingRef.current = true
    try {
      const res = await templatesService.create({ ...source, name: trimmedName })
      const template = res.template
      if (!res.success || !template) throw new Error(res.error ?? 'create failed')
      toast.success(t('saveNoteAsTemplate.success'), {
        action: {
          label: t('saveNoteAsTemplate.edit'),
          onClick: () =>
            openTab({
              type: 'template-editor',
              title: template.name,
              icon: 'file-text',
              path: `/templates/${template.id}`,
              entityId: template.id,
              isPinned: false,
              isModified: false,
              isPreview: false,
              isDeleted: false
            })
        }
      })
      onClose()
    } catch (err) {
      log.error('failed to save the template', { err })
      toast.error(extractErrorMessage(err, t('saveNoteAsTemplate.failed')))
    } finally {
      submittingRef.current = false
    }
  }, [source, trimmedName, openTab, onClose, t])

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[460px]" data-testid="save-note-as-template-dialog">
        <DialogHeader>
          <DialogTitle>{t('saveNoteAsTemplate.title')}</DialogTitle>
          <DialogDescription>{t('saveNoteAsTemplate.description')}</DialogDescription>
        </DialogHeader>
        {source === null ? (
          <p className="text-xs text-muted-foreground">{t('saveNoteAsTemplate.loading')}</p>
        ) : (
          <div className="flex flex-col gap-2">
            <Input
              autoFocus
              value={name}
              maxLength={MAX_TEMPLATE_NAME_LENGTH}
              aria-label={t('saveNoteAsTemplate.nameLabel')}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                e.preventDefault()
                void submit()
              }}
            />
            <p className="text-xs text-muted-foreground">
              {t('saveNoteAsTemplate.summary', {
                tagCount: source.tags?.length ?? 0,
                propertyCount: source.properties?.length ?? 0
              })}
            </p>
          </div>
        )}
        <DialogFooter className="flex-col gap-2 sm:flex-col sm:items-stretch">
          <Button onClick={() => void submit()} disabled={source === null || !trimmedName}>
            {t('saveNoteAsTemplate.save')}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t('saveNoteAsTemplate.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default SaveNoteAsTemplateDialog
