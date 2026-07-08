import { useState, useCallback } from 'react'
import { toast } from 'sonner'
import { TemplateSelector } from './template-selector'
import { ApplyTemplateConfirmDialog } from './apply-template-confirm-dialog'
import { useTemplates } from '@/hooks/use-templates'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useT } from '@memry/i18n/renderer'

interface ApplyTemplateToNoteDialogProps {
  noteId: string | null
  isOpen: boolean
  onClose: () => void
}

export function ApplyTemplateToNoteDialog(props: ApplyTemplateToNoteDialogProps) {
  if (!props.isOpen) return null
  return <ApplyTemplateToNoteDialogActive {...props} />
}

function ApplyTemplateToNoteDialogActive({
  noteId,
  isOpen,
  onClose
}: ApplyTemplateToNoteDialogProps) {
  const { t } = useT('notes')
  const { templates } = useTemplates()
  const [pendingTemplateId, setPendingTemplateId] = useState<string | null>(null)

  const apply = useCallback(
    async (templateId: string, mode: 'full' | 'body') => {
      if (!noteId) return
      try {
        const res = await window.api.notes.applyTemplate({ noteId, templateId, mode })
        if (!res.success) throw new Error(res.error ?? 'apply failed')
        toast.success(t('applyTemplateConfirm.success'))
      } catch (err) {
        toast.error(extractErrorMessage(err, t('applyTemplateConfirm.failed')))
      } finally {
        setPendingTemplateId(null)
        onClose()
      }
    },
    [noteId, onClose, t]
  )

  const handleSelect = useCallback(
    async (templateId: string | null) => {
      if (!noteId || !templateId) {
        onClose()
        return
      }
      const note = await window.api.notes.get(noteId)
      const hasContent = !!note?.content?.trim()
      if (hasContent) {
        setPendingTemplateId(templateId)
      } else {
        await apply(templateId, 'full')
      }
    },
    [noteId, apply, onClose]
  )

  const pendingTemplateName = templates.find((tpl) => tpl.id === pendingTemplateId)?.name ?? ''

  return (
    <>
      <TemplateSelector
        isOpen={isOpen && pendingTemplateId === null}
        applyMode
        onClose={onClose}
        onSelect={(id) => void handleSelect(id)}
      />
      <ApplyTemplateConfirmDialog
        isOpen={pendingTemplateId !== null}
        templateName={pendingTemplateName}
        onCancel={() => {
          setPendingTemplateId(null)
          onClose()
        }}
        onConfirm={(mode) => {
          if (pendingTemplateId) void apply(pendingTemplateId, mode)
        }}
      />
    </>
  )
}

export default ApplyTemplateToNoteDialog
