import { useCallback, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import {
  GRAPH_LINK_PROPERTY,
  addRelationTarget,
  hasTag,
  noteRelationUri,
  removeRelationTarget,
  restoreRelationTarget
} from '@/lib/graph-edits'
import { propertiesService } from '@/services/properties-service'
import { notesService } from '@/services/notes-service'
import { useNoteMutations } from '@/hooks/use-notes-query'
import { graphKeys } from '@/hooks/use-graph-data'

const log = createLogger('Hook:GraphEdits')

export interface GraphEdits {
  /** Add `targetId` to the source note's `related` relation property. */
  linkNotes: (sourceId: string, targetId: string, labels: LinkLabels) => Promise<void>
  /** Remove `targetId` from every relation property on the source note. */
  unlinkNotes: (sourceId: string, targetId: string, labels: LinkLabels) => Promise<void>
  addTag: (noteId: string, tag: string) => Promise<void>
}

export interface LinkLabels {
  source: string
  target: string
}

async function readProperties(entityId: string): Promise<Record<string, unknown>> {
  const props = await propertiesService.get(entityId)
  return Object.fromEntries(props.map((p) => [p.name, p.value]))
}

async function writeProperties(
  entityId: string,
  properties: Record<string, unknown>
): Promise<void> {
  const result = await propertiesService.set(entityId, properties)
  if (!result.success) throw new Error(result.error ?? 'Failed to update properties')
}

/**
 * Graph-side edits. Every write goes through the same IPC the note page uses
 * (`properties:set` for relations, `notes:update` for tags), so nothing new
 * reaches disk or sync. Undo re-reads the note and applies the inverse edit
 * instead of restoring a snapshot, so a change made in between is kept.
 */
export function useGraphEdits(): GraphEdits {
  const { t } = useT('graph')
  const { t: tCommon } = useT('common')
  const queryClient = useQueryClient()
  const updateNoteAsync = useNoteMutations().updateNote.mutateAsync

  // `notes:updated` already invalidates the graph, but only after a debounce;
  // refetching here makes the edge show up as soon as the write lands.
  const refreshGraph = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: graphKeys.all })
  }, [queryClient])

  const unlinkNotes = useCallback(
    async (sourceId: string, targetId: string, labels: LinkLabels): Promise<void> => {
      const uri = noteRelationUri(targetId)
      try {
        const { properties, removedFrom } = removeRelationTarget(
          await readProperties(sourceId),
          uri
        )
        if (removedFrom.length === 0) return
        await writeProperties(sourceId, properties)
        refreshGraph()
        toast(t('edit.unlinked', { ...labels }), {
          action: {
            label: tCommon('action.undo'),
            onClick: () => {
              void (async () => {
                try {
                  const current = await readProperties(sourceId)
                  await writeProperties(sourceId, restoreRelationTarget(current, removedFrom, uri))
                  refreshGraph()
                } catch (err) {
                  log.error('undo unlink failed:', err)
                  toast.error(extractErrorMessage(err, t('edit.undo-failed')))
                }
              })()
            }
          }
        })
      } catch (err) {
        log.error('unlink failed:', err)
        toast.error(extractErrorMessage(err, t('edit.unlink-failed')))
      }
    },
    [refreshGraph, t, tCommon]
  )

  const linkNotes = useCallback(
    async (sourceId: string, targetId: string, labels: LinkLabels): Promise<void> => {
      if (sourceId === targetId) return
      const uri = noteRelationUri(targetId)
      try {
        const result = addRelationTarget(await readProperties(sourceId), GRAPH_LINK_PROPERTY, uri)
        if (result.status === 'already-linked') {
          toast(t('edit.already-linked', { ...labels }))
          return
        }
        if (result.status === 'property-conflict') {
          toast.error(t('edit.property-conflict', { property: GRAPH_LINK_PROPERTY }))
          return
        }
        await writeProperties(sourceId, result.properties)
        refreshGraph()
        toast(t('edit.linked', { ...labels, property: GRAPH_LINK_PROPERTY }), {
          action: {
            label: tCommon('action.undo'),
            onClick: () => {
              void (async () => {
                try {
                  const current = await readProperties(sourceId)
                  const value = current[GRAPH_LINK_PROPERTY]
                  if (!Array.isArray(value) || !value.includes(uri)) return
                  await writeProperties(sourceId, {
                    ...current,
                    [GRAPH_LINK_PROPERTY]: value.filter((v) => v !== uri)
                  })
                  refreshGraph()
                } catch (err) {
                  log.error('undo link failed:', err)
                  toast.error(extractErrorMessage(err, t('edit.undo-failed')))
                }
              })()
            }
          }
        })
      } catch (err) {
        log.error('link failed:', err)
        toast.error(extractErrorMessage(err, t('edit.link-failed')))
      }
    },
    [refreshGraph, t, tCommon]
  )

  const addTag = useCallback(
    async (noteId: string, tag: string): Promise<void> => {
      try {
        const note = await notesService.get(noteId)
        if (!note) throw new Error('Note not found')
        if (hasTag(note.tags, tag)) {
          toast(t('edit.tag-exists', { tag }))
          return
        }
        const result = await updateNoteAsync({ id: noteId, tags: [...note.tags, tag] })
        if (!result.success) throw new Error(result.error ?? 'Failed to add tag')
        refreshGraph()
        toast(t('edit.tag-added', { tag, note: note.title }), {
          action: {
            label: tCommon('action.undo'),
            onClick: () => {
              void (async () => {
                try {
                  const latest = await notesService.get(noteId)
                  if (!latest || !latest.tags.includes(tag)) return
                  await updateNoteAsync({
                    id: noteId,
                    tags: latest.tags.filter((existing) => existing !== tag)
                  })
                  refreshGraph()
                } catch (err) {
                  log.error('undo tag failed:', err)
                  toast.error(extractErrorMessage(err, t('edit.undo-failed')))
                }
              })()
            }
          }
        })
      } catch (err) {
        log.error('add tag failed:', err)
        toast.error(extractErrorMessage(err, t('edit.tag-failed')))
      }
    },
    [refreshGraph, t, tCommon, updateNoteAsync]
  )

  return useMemo(() => ({ linkNotes, unlinkNotes, addTag }), [linkNotes, unlinkNotes, addTag])
}
