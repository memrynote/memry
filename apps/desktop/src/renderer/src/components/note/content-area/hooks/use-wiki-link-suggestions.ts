/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useRef } from 'react'
import { fuzzySearch } from '@/lib/fuzzy-search'
import { notesService } from '@/services/notes-service'
import { createWikiLinkInlineContent } from '../wiki-link'
import { splitWikiLinkQuery } from '../wiki-link-utils'
import type { WikiLinkSuggestionItem } from '../wiki-link-menu'
import { createLogger } from '@/lib/logger'

const log = createLogger('Hook:WikiLinkSuggestions')

type NoteSuggestion = {
  id: string
  title: string
  modified?: Date | string
  fileType?: 'markdown' | 'pdf' | 'image' | 'audio' | 'video'
  mimeType?: string | null
  fileSize?: number | null
}

function toMemryFileUrl(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, '/')
  return normalized.startsWith('/')
    ? `memry-file://local${normalized}`
    : `memry-file://local/${normalized}`
}

function blockHasContent(block: any): boolean {
  const content = block?.content
  if (typeof content === 'string') return content.trim().length > 0
  if (!Array.isArray(content)) return false

  return content.some((item) => {
    if (typeof item === 'string') return item.trim().length > 0
    if (item?.type === 'text') return Boolean((item.text ?? '').trim())
    return Boolean(item)
  })
}

function createAudioFileBlockContent(props: {
  url: string
  name: string
  size: number
  mimeType: string
}) {
  return {
    type: 'file' as const,
    props
  }
}

export function useWikiLinkSuggestions(editor: any) {
  const notesCacheRef = useRef<{ notes: NoteSuggestion[]; fetchedAt: number } | null>(null)

  const getWikiLinkItems = useCallback(async (query: string): Promise<WikiLinkSuggestionItem[]> => {
    const now = Date.now()
    const cache = notesCacheRef.current
    const shouldRefresh = !cache || now - cache.fetchedAt > 5000
    if (shouldRefresh) {
      try {
        const result = await notesService.list({ limit: 500, sortBy: 'modified' })
        notesCacheRef.current = {
          notes: result.notes.map((note) => ({
            id: note.id,
            title: note.title,
            modified: note.modified,
            fileType: note.fileType,
            mimeType: note.mimeType,
            fileSize: note.fileSize
          })),
          fetchedAt: now
        }
      } catch (error) {
        log.error('Failed to load wiki link suggestions', error)
        notesCacheRef.current = { notes: [], fetchedAt: now }
      }
    }

    const notes = notesCacheRef.current?.notes ?? []
    const { search, alias } = splitWikiLinkQuery(query)
    const filtered = search ? fuzzySearch(notes, search, ['title']) : notes
    const sorted = filtered.slice(0, 10)

    const suggestions: WikiLinkSuggestionItem[] = sorted.map((note) => ({
      id: note.id,
      title: note.title,
      target: note.title,
      alias,
      exists: true,
      type: 'note',
      lastEdited: note.modified instanceof Date ? note.modified.toISOString() : note.modified,
      ...(note.fileType && note.fileType !== 'markdown' ? { fileType: note.fileType } : {}),
      ...(note.mimeType ? { mimeType: note.mimeType } : {}),
      ...(note.fileSize != null ? { fileSize: note.fileSize } : {})
    }))

    const hasExactMatch = search
      ? filtered.some((note) => note.title.toLowerCase() === search.toLowerCase())
      : true

    if (search && !hasExactMatch) {
      suggestions.push({
        id: `create:${search}`,
        title: search,
        target: search,
        alias,
        exists: false,
        type: 'create'
      })
    }

    return suggestions
  }, [])

  const insertWikiLink = useCallback(
    (item: WikiLinkSuggestionItem) => {
      if (!item.target) return
      editor.insertInlineContent([createWikiLinkInlineContent(item.target, item.alias ?? '')], {
        updateSelection: true
      })
      editor.insertInlineContent([' '], { updateSelection: true })
    },
    [editor]
  )

  const handleWikiLinkSelect = useCallback(
    async (item: WikiLinkSuggestionItem) => {
      if (!item.target) return

      if (item.insertMode === 'embed' && item.fileType === 'audio') {
        const anchorBlock = editor.getTextCursorPosition?.().block

        try {
          const file = await notesService.getFile(item.id)
          if (file?.fileType === 'audio') {
            const fileBlock = createAudioFileBlockContent({
              url: toMemryFileUrl(file.absolutePath),
              name: file.title || item.title,
              size: file.fileSize ?? item.fileSize ?? 0,
              mimeType: file.mimeType ?? item.mimeType ?? 'audio/mpeg'
            })
            const liveAnchor = anchorBlock?.id
              ? (editor.getBlock?.(anchorBlock.id) ?? anchorBlock)
              : anchorBlock

            if (liveAnchor && !blockHasContent(liveAnchor)) {
              editor.updateBlock(liveAnchor, fileBlock)
            } else if (liveAnchor) {
              editor.insertBlocks([fileBlock], liveAnchor, 'after')
            } else {
              insertWikiLink(item)
            }
            return
          }
        } catch (error) {
          log.error('Failed to embed audio wiki link', error)
        }
      }

      insertWikiLink(item)
    },
    [editor, insertWikiLink]
  )

  return { getWikiLinkItems, handleWikiLinkSelect }
}
