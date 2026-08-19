/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useRef } from 'react'
import { extractMarkdownHeadings, type MarkdownHeading } from '@memry/shared/markdown-headings'
import { isBlockReference } from '@memry/shared/wiki-target'
import { fuzzySearch } from '@/lib/fuzzy-search'
import { toMemryFileUrl } from '@/lib/memry-file-url'
import { notesService } from '@/services/notes-service'
import { createWikiLinkInlineContent } from '../wiki-link'
import { parseWikiLinkQuery, pickAlias } from '../wiki-link-utils'
import { activeRunWikiLink, replaceActiveRunWithWikiLink } from '../wiki-link-edit-plugin'
import type { WikiLinkSuggestionItem } from '../wiki-link-menu'
import { createLogger } from '@/lib/logger'

const log = createLogger('Hook:WikiLinkSuggestions')

const CACHE_TTL_MS = 5000

type NoteSuggestion = {
  id: string
  title: string
  path: string
  modified?: Date | string
  fileType?: 'markdown' | 'pdf' | 'image' | 'audio' | 'video'
  mimeType?: string | null
  fileSize?: number | null
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

/**
 * The single row the menu becomes once BOTH halves of `[[target|alias]]` are
 * settled — the target names something exactly and a label was typed after the
 * `|`. Picking anything else at that point would be picking a target again.
 */
function aliasRow(target: string, alias: string): WikiLinkSuggestionItem {
  return {
    id: `alias:${target}`,
    title: alias,
    target,
    alias,
    exists: true,
    type: 'alias'
  }
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
  // Headings have no index in either database, so `#` reads the target note's
  // body on demand. Cached per note, same 5s window as the note list.
  const headingsCacheRef = useRef(
    new Map<string, { headings: MarkdownHeading[]; fetchedAt: number }>()
  )

  const loadHeadings = useCallback(
    async (note: NoteSuggestion, now: number): Promise<MarkdownHeading[]> => {
      const cached = headingsCacheRef.current.get(note.id)
      if (cached && now - cached.fetchedAt <= CACHE_TTL_MS) return cached.headings

      let headings: MarkdownHeading[] = []
      try {
        // By path, not by id: `notes:get` counts as opening the note and emits
        // `note_opened`, and typing `#` in someone else's link is not that.
        const full = note.path ? await notesService.getByPath(note.path) : null
        headings = full?.content ? extractMarkdownHeadings(full.content) : []
      } catch (error) {
        log.error('Failed to load wiki link heading suggestions', error)
      }

      headingsCacheRef.current.set(note.id, { headings, fetchedAt: now })
      return headings
    },
    []
  )

  const getWikiLinkItems = useCallback(
    async (query: string): Promise<WikiLinkSuggestionItem[]> => {
      const now = Date.now()
      const cache = notesCacheRef.current
      const shouldRefresh = !cache || now - cache.fetchedAt > CACHE_TTL_MS
      if (shouldRefresh) {
        try {
          const result = await notesService.list({ limit: 500, sortBy: 'modified' })
          notesCacheRef.current = {
            notes: result.notes.map((note) => ({
              id: note.id,
              title: note.title,
              path: note.path,
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
      const { search, note: notePart, heading, alias } = parseWikiLinkQuery(query)

      // `#` is a separator, not a trigger. It switches the menu to the note's
      // headings only once the note half names a note EXACTLY — `[[Topl#` still
      // lists notes, `[[Toplantı#` lists Toplantı's headings — which is also what
      // keeps `[[Sprint #4]]` (a real title) reaching the note list. Backspacing
      // over the `#` needs no unwinding: the query is re-parsed on every keystroke.
      // Block references (`#^id`) are not a heading Memry can offer, so they fall
      // through to the note list rather than showing an empty heading menu.
      const headingTarget =
        heading !== null && !isBlockReference(heading)
          ? notes.find((note) => note.title.toLowerCase() === notePart.toLowerCase())
          : undefined

      if (headingTarget) {
        const headings = await loadHeadings(headingTarget, now)
        const matches = heading ? fuzzySearch(headings, heading, ['text']) : headings

        // Target already settled and a label typed after `|`: there is nothing
        // left to choose, so the menu becomes the one row that commits it.
        const exactHeading = heading ? headings.find((item) => item.text === heading) : undefined
        if (alias && exactHeading) {
          return [aliasRow(`${headingTarget.title}#${exactHeading.text}`, alias)]
        }

        if (matches.length === 0) {
          return [
            {
              id: `headings:${headingTarget.id}`,
              title: headingTarget.title,
              target: '',
              alias,
              exists: true,
              type: 'headingEmpty',
              filtered: headings.length > 0
            }
          ]
        }

        return matches.slice(0, 10).map((match, index) => ({
          id: `heading:${headingTarget.id}:${index}`,
          title: match.text,
          // One raw string, exactly as a hand-typed link would be written.
          target: `${headingTarget.title}#${match.text}`,
          alias,
          exists: true,
          type: 'heading',
          headingLevel: match.level
        }))
      }

      const filtered = search ? fuzzySearch(notes, search, ['title']) : notes

      const exactNote = search
        ? filtered.find((note) => note.title.toLowerCase() === search.toLowerCase())
        : undefined
      if (alias && exactNote) {
        return [aliasRow(exactNote.title, alias)]
      }

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

      const hasExactMatch = search ? Boolean(exactNote) : true

      if (search && !hasExactMatch) {
        // The row names the note that will actually be created, which is the
        // note half — `resolveWikiLink` never mints a filename carrying a `#`.
        // A trailing `#` with nothing after it is a half-typed separator rather
        // than a heading, so it is dropped from the link text too instead of
        // being written to the file as `[[tokyo tip#]]`.
        const createTitle = heading !== null ? notePart : search
        const createTarget = heading ? search : createTitle
        if (createTitle) {
          suggestions.push({
            id: `create:${createTitle}`,
            title: createTitle,
            target: createTarget,
            alias,
            exists: false,
            type: 'create'
          })
        }
      }

      return suggestions
    },
    [loadHeadings]
  )

  const insertWikiLink = useCallback(
    (item: WikiLinkSuggestionItem) => {
      if (!item.target) return

      // The raw run holds the half the query cannot see — an edited chip's own
      // label, or the text "link this selection" parked there. Read it before
      // the run is replaced.
      const content = createWikiLinkInlineContent(
        item.target,
        pickAlias(item, activeRunWikiLink(editor))
      )

      // Editing an existing link: the menu's `clearQuery` removed the query text
      // but left the `[[` and `]]` around it, so inserting here would produce
      // `[[<chip>]]`. Replace the whole run instead. Also no trailing space —
      // that belongs to the from-scratch path, where the user is still writing.
      if (replaceActiveRunWithWikiLink(editor, content.props)) return

      editor.insertInlineContent([content], { updateSelection: true })
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
