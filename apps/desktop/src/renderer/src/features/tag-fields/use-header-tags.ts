import { useCallback } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { useNoteMutations } from '@/hooks/use-notes-query'
import { notesService } from '@/services/notes-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { buildFieldGroups, isFilledValue } from './build-field-groups'
import { resolveTag, useTagSchemas } from './use-tag-schemas'
import { templateOffers } from './template-offers'

const log = createLogger('HeaderTags')

export interface UseHeaderTagsArgs {
  noteId: string | null
  noteTitle: string
  headerTags: readonly string[]
  values: Readonly<Record<string, unknown>>
  canEdit: () => boolean
  onFieldTagAdded?: (tag: string) => void
}

export interface HeaderTagActions {
  addTag: (name: string) => Promise<void>
  removeTag: (name: string) => Promise<void>
}

const hasTag = (tags: readonly string[], name: string): boolean =>
  tags.some((tag) => tag.toLowerCase() === name.toLowerCase())

export function useHeaderTags({
  noteId,
  noteTitle,
  headerTags,
  values,
  canEdit,
  onFieldTagAdded
}: UseHeaderTagsArgs): HeaderTagActions {
  const { t } = useT('notes')
  const { t: tCommon } = useT('common')
  const { updateNote } = useNoteMutations()
  const { data: snapshot } = useTagSchemas()

  const undoTemplate = useCallback(
    async (id: string, undoToken: string) => {
      try {
        const result = await notesService.undoTagTemplate({ noteId: id, undoToken })
        if (result.status === 'stale') toast(t('tagFields.toast.templateChanged'))
      } catch (err) {
        log.error('undo tag template failed:', err)
        toast.error(extractErrorMessage(err, t('tagFields.toast.undoFailed')))
      }
    },
    [t]
  )

  const addTag = useCallback(
    async (name: string) => {
      if (!noteId || !canEdit() || hasTag(headerTags, name)) return
      try {
        const result = await updateNote.mutateAsync({ id: noteId, headerTags: { add: [name] } })
        if (!result.success) throw new Error(result.error ?? 'Failed to add tag')
        const resolved = resolveTag(snapshot, name)
        if (resolved?.hasFields) onFieldTagAdded?.(resolved.key)
        const outcome = result.tagTemplate
        if (outcome?.kind === 'offered') templateOffers.mark(noteId, outcome.tag)
        if (outcome?.kind === 'applied') {
          toast(
            t('tagFields.toast.becameObject', {
              title: noteTitle || t('editor.title.untitled'),
              tag: (resolved?.name ?? outcome.tag).toLowerCase()
            }),
            {
              action: {
                label: tCommon('action.undo'),
                onClick: () => void undoTemplate(noteId, outcome.undoToken)
              }
            }
          )
        }
      } catch (err) {
        log.error('add tag failed:', err)
        toast.error(extractErrorMessage(err, t('tagFields.toast.addFailed')))
      }
    },
    [
      noteId,
      canEdit,
      headerTags,
      updateNote,
      snapshot,
      onFieldTagAdded,
      noteTitle,
      t,
      tCommon,
      undoTemplate
    ]
  )

  const removeTag = useCallback(
    async (name: string) => {
      if (!noteId || !canEdit()) return
      const resolved = resolveTag(snapshot, name)
      const kept = resolved?.hasFields
        ? buildFieldGroups([name], snapshot, values)
            .groups.flatMap((group) => group.slots)
            .filter((slot) => isFilledValue(slot.value)).length
        : 0
      try {
        const result = await updateNote.mutateAsync({ id: noteId, headerTags: { remove: [name] } })
        if (!result.success) throw new Error(result.error ?? 'Failed to remove tag')
        templateOffers.resolve(noteId, name)
        if (!resolved?.hasFields) return
        toast(
          kept === 1
            ? t('tagFields.toast.removedKeptOne', { tag: name })
            : t('tagFields.toast.removedKept', { tag: name, count: kept }),
          {
            action: {
              label: tCommon('action.undo'),
              onClick: () => {
                updateNote
                  .mutateAsync({ id: noteId, headerTags: { add: [name] } })
                  .catch((err: unknown) => {
                    log.error('undo untag failed:', err)
                    toast.error(extractErrorMessage(err, t('tagFields.toast.undoFailed')))
                  })
              }
            }
          }
        )
      } catch (err) {
        log.error('remove tag failed:', err)
        toast.error(extractErrorMessage(err, t('tagFields.toast.removeFailed')))
      }
    },
    [noteId, canEdit, snapshot, values, updateNote, t, tCommon]
  )

  return { addTag, removeTag }
}
