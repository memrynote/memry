/**
 * Titles and icons for a task's related items (linked notes, files and
 * canvases), shared by the task drawer and the inline task block.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FileType } from '@memry/shared/file-types'
import { notesService } from '@/services/notes-service'
import { canvasService } from '@/services/canvas-service'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'

const log = createLogger('TaskRelatedItems')

// A note and a canvas can carry the same id, so a related item is addressed by
// a discriminated reference rather than a bare id. Storage stays two disjoint
// fields; only this layer unions them.
export type RelatedRef = { kind: 'note'; id: string } | { kind: 'canvas'; id: string }

export type RelatedItemInfo =
  | { kind: 'note'; title: string; emoji?: string | null; fileType: FileType }
  | { kind: 'canvas'; title: string; icon: string | null }

export type RelatedItemKey = `${RelatedRef['kind']}:${string}`
export type RelatedItemInfoByKey = Partial<Record<RelatedItemKey, RelatedItemInfo>>

export const relatedItemKey = (ref: RelatedRef): RelatedItemKey => `${ref.kind}:${ref.id}`

const EMPTY_RELATED_ITEMS: RelatedItemInfoByKey = {}
const splitKey = (key: string): string[] => (key ? key.split(',') : [])

export interface RelatedItemInfoState {
  refs: RelatedRef[]
  /** Resolved title/icon per item; an item still loading has no entry. */
  infoByKey: RelatedItemInfoByKey
  /** Record an item's info the moment it is linked, before the lookup runs. */
  remember: (ref: RelatedRef, info: RelatedItemInfo) => void
  /** Drop an unlinked item's info. */
  forget: (ref: RelatedRef) => void
}

export function useRelatedItemInfo(
  linkedNoteIds: readonly string[] | undefined,
  linkedCanvasIds: readonly string[] | undefined,
  untitledCanvasLabel: string
): RelatedItemInfoState {
  const [noteNames, setNoteNames] = useState<RelatedItemInfoByKey>({})
  const [canvasNames, setCanvasNames] = useState<RelatedItemInfoByKey>({})

  // Keyed by content, not array identity: every task update hands over a new
  // array with the same ids, and that must not re-run the lookups.
  const noteKey = linkedNoteIds?.join(',') ?? ''
  const canvasKey = linkedCanvasIds?.join(',') ?? ''

  const refs = useMemo<RelatedRef[]>(
    () => [
      ...splitKey(noteKey).map((id): RelatedRef => ({ kind: 'note', id })),
      ...splitKey(canvasKey).map((id): RelatedRef => ({ kind: 'canvas', id }))
    ],
    [noteKey, canvasKey]
  )

  const infoByKey = useMemo(
    () => (refs.length ? { ...noteNames, ...canvasNames } : EMPTY_RELATED_ITEMS),
    [refs.length, noteNames, canvasNames]
  )

  useEffect(() => {
    const ids = splitKey(noteKey)
    if (!ids.length) return
    let cancelled = false
    void Promise.all(
      ids.map(async (id) => {
        try {
          const file = await notesService.getFile(id)
          if (file) {
            return [
              relatedItemKey({ kind: 'note', id }),
              { kind: 'note' as const, title: file.title, emoji: null, fileType: file.fileType }
            ] as const
          }

          const note = await notesService.get(id)
          return note
            ? ([
                relatedItemKey({ kind: 'note', id }),
                {
                  kind: 'note' as const,
                  title: note.title,
                  emoji: note.emoji,
                  fileType: 'markdown' as const
                }
              ] as const)
            : null
        } catch {
          return null
        }
      })
    ).then((results) => {
      if (cancelled) return
      const names: RelatedItemInfoByKey = {}
      for (const r of results) if (r) names[r[0]] = r[1]
      setNoteNames(names)
    })
    return () => {
      cancelled = true
    }
  }, [noteKey])

  useEffect(() => {
    const ids = splitKey(canvasKey)
    if (!ids.length) return
    let cancelled = false
    const linked = new Set(ids)
    void canvasService.list().then(
      (response) => {
        if (cancelled) return
        const names: RelatedItemInfoByKey = {}
        for (const canvas of response.canvases) {
          if (!linked.has(canvas.id)) continue
          names[relatedItemKey({ kind: 'canvas', id: canvas.id })] = {
            kind: 'canvas',
            title: canvas.title || untitledCanvasLabel,
            icon: canvas.icon
          }
        }
        setCanvasNames(names)
      },
      (err: unknown) => {
        if (cancelled) return
        log.error('Linked canvas lookup failed:', extractErrorMessage(err))
      }
    )
    return () => {
      cancelled = true
    }
  }, [canvasKey, untitledCanvasLabel])

  const remember = useCallback((ref: RelatedRef, info: RelatedItemInfo) => {
    const set = ref.kind === 'canvas' ? setCanvasNames : setNoteNames
    set((prev) => ({ ...prev, [relatedItemKey(ref)]: info }))
  }, [])

  const forget = useCallback((ref: RelatedRef) => {
    const set = ref.kind === 'canvas' ? setCanvasNames : setNoteNames
    set((prev) => {
      const next = { ...prev }
      delete next[relatedItemKey(ref)]
      return next
    })
  }, [])

  return { refs, infoByKey, remember, forget }
}
