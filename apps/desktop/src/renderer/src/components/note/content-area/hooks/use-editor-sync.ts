/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useRef } from 'react'
import { removeAndInsertBlocks, type Block } from '@blocknote/core'
import { yUndoPluginKey } from 'y-prosemirror'
import type * as Y from 'yjs'
import {
  extractHeadings,
  normalizeWikiLinks,
  normalizeMarkdownHardBreaks
} from '../wiki-link-utils'
import { normalizeHashTags, extractInlineTags } from '../hash-tag'
import { normalizeNoteBlocks } from '../normalize-note-blocks'
import {
  parseMarkdownPreservingBlanks,
  sanitizeBlockIds,
  serializeBlocksPreservingBlanks
} from '../markdown-utils'
import { createLinkMentionContent } from '../link-mention'
import { fetchLinkPreview } from '@/lib/url-metadata'
import type { HeadingInfo } from '../types'
import { createLogger } from '@/lib/logger'

const log = createLogger('Hook:EditorSync')
const activeNoteEditors = new Map<string, any>()

function replaceInitialBlocksWithoutHistory(editor: any, blocks: Block[]): void {
  if (typeof editor.transact !== 'function') {
    editor.replaceBlocks(editor.document, blocks)
    return
  }

  editor.transact((tr: any) => {
    tr.setMeta?.('addToHistory', false)
    return removeAndInsertBlocks(
      tr,
      editor.document,
      blocks as Parameters<typeof removeAndInsertBlocks>[2]
    )
  })
}

function clearYjsUndoHistory(editor: any): void {
  const state = editor?._tiptapEditor?.state
  if (!state) return

  const undoManager = yUndoPluginKey.getState(state)?.undoManager
  undoManager?.clear?.(true, true)
  undoManager?.stopCapturing?.()
}

export async function extractMarkdownFromActiveEditor(noteId?: string): Promise<string | null> {
  if (!noteId) return null

  const editor = activeNoteEditors.get(noteId)
  if (!editor) return null

  return serializeBlocksPreservingBlanks(editor, editor.document as Block[])
}

function hydrateLinkMentionFavicons(editor: any): void {
  const mentions: { block: any; index: number; url: string }[] = []

  const walk = (blocks: any[]): void => {
    for (const block of blocks) {
      const content = block.content
      if (Array.isArray(content)) {
        content.forEach((c: any, i: number) => {
          if (
            c.type === 'linkMention' &&
            c.props?.url &&
            (!c.props.favicon || !c.props.siteName || !c.props.title)
          ) {
            mentions.push({ block, index: i, url: c.props.url })
          }
        })
      }
      if (block.children?.length) walk(block.children)
    }
  }

  walk(editor.document)

  for (const { block, index, url } of mentions) {
    fetchLinkPreview(url)
      .then((metadata) => {
        const current = block.content
        if (!Array.isArray(current)) return
        if (current[index]?.type !== 'linkMention') return
        const updated = [...current]
        updated[index] = createLinkMentionContent(
          url,
          metadata.domain || current[index].props.domain,
          metadata.title || current[index].props.title,
          metadata.favicon,
          metadata.siteName || current[index].props.siteName
        )
        editor.updateBlock(block, { content: updated })
      })
      .catch(() => {})
  }
}

interface EditorSyncParams {
  editor: any
  noteId?: string
  initialContent?: Block[] | string
  contentType?: 'html' | 'markdown' | 'blocks'
  yjsFragment?: Y.XmlFragment
  isRemoteUpdateRef?: React.RefObject<boolean>
  noteTags?: string[]
  tagColorMap?: Map<string, string>
  tagIconMap?: Map<string, string>
  onContentChange?: (blocks: Block[]) => void
  onMarkdownChange?: (markdown: string) => void
  onHeadingsChange?: (headings: HeadingInfo[]) => void
  onInlineTagsChange?: (tags: string[]) => void
}

interface EditorSyncResult {
  handleChange: () => void
  isContentReadyRef: React.RefObject<boolean>
  prevInlineTagsRef: React.MutableRefObject<string[]>
  lastNormalizedTagsRef: React.MutableRefObject<string>
}

export function useEditorSync({
  editor,
  noteId,
  initialContent,
  contentType = 'html',
  yjsFragment,
  isRemoteUpdateRef,
  noteTags,
  tagColorMap,
  tagIconMap,
  onContentChange,
  onMarkdownChange,
  onHeadingsChange,
  onInlineTagsChange
}: EditorSyncParams): EditorSyncResult {
  const initialContentLoadedRef = useRef(false)
  const isContentReadyRef = useRef(false)
  const prevInlineTagsRef = useRef<string[]>([])
  const lastNormalizedTagsRef = useRef<string>('')

  const markdownDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const headingsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inlineTagsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Cleanup debounce timers on unmount
  useEffect(() => {
    return () => {
      if (markdownDebounceRef.current) clearTimeout(markdownDebounceRef.current)
      if (headingsDebounceRef.current) clearTimeout(headingsDebounceRef.current)
      if (inlineTagsDebounceRef.current) clearTimeout(inlineTagsDebounceRef.current)
    }
  }, [])

  useEffect(() => {
    if (!noteId) return

    activeNoteEditors.set(noteId, editor)
    return () => {
      if (activeNoteEditors.get(noteId) === editor) activeNoteEditors.delete(noteId)
    }
  }, [editor, noteId])

  // Parse content on initial mount (uncontrolled component pattern).
  // Cancellation flag + cleanup return mark this as a synchronization effect
  // so the unnecessary-effect lints recognize it as legitimate.
  useEffect(() => {
    if (initialContentLoadedRef.current) {
      return
    }
    initialContentLoadedRef.current = true

    let cancelled = false

    if (yjsFragment) {
      clearYjsUndoHistory(editor)
      isContentReadyRef.current = true
      if (onHeadingsChange) {
        const headings = extractHeadings(editor.document as Block[])
        if (!cancelled) onHeadingsChange(headings)
      }
      return () => {
        cancelled = true
      }
    }

    async function loadContent(): Promise<void> {
      let loadedSuccessfully = false
      try {
        if (typeof initialContent === 'string' && initialContent.trim()) {
          try {
            let content = initialContent

            if (contentType === 'markdown') {
              content = normalizeMarkdownHardBreaks(content)
            }

            let blocks
            if (contentType === 'markdown') {
              blocks = await parseMarkdownPreservingBlanks(editor, content)
            } else {
              blocks = await editor.tryParseHTMLToBlocks(content)
            }

            let normalizedBlocks = normalizeNoteBlocks(blocks)

            if (noteTags?.length && tagColorMap) {
              const tagSet = new Set(noteTags.map((t) => t.toLowerCase()))
              const hashNormalized = normalizeHashTags(
                normalizedBlocks,
                tagSet,
                tagColorMap,
                tagIconMap
              )
              normalizedBlocks = hashNormalized.blocks
              lastNormalizedTagsRef.current = noteTags.slice().sort().join(',')
            }

            normalizedBlocks = sanitizeBlockIds(normalizedBlocks)
            replaceInitialBlocksWithoutHistory(editor, normalizedBlocks)
            hydrateLinkMentionFavicons(editor)
            loadedSuccessfully = true
          } catch (error) {
            log.error(`Failed to parse ${contentType} content`, error)
          }
        } else if (Array.isArray(initialContent) && initialContent.length > 0) {
          let normalizedBlocks = normalizeNoteBlocks(initialContent)

          if (noteTags?.length && tagColorMap) {
            const tagSet = new Set(noteTags.map((t) => t.toLowerCase()))
            const hashNormalized = normalizeHashTags(
              normalizedBlocks,
              tagSet,
              tagColorMap,
              tagIconMap
            )
            normalizedBlocks = hashNormalized.blocks
            lastNormalizedTagsRef.current = noteTags.slice().sort().join(',')
          }

          normalizedBlocks = sanitizeBlockIds(normalizedBlocks)
          replaceInitialBlocksWithoutHistory(editor, normalizedBlocks)
          hydrateLinkMentionFavicons(editor)
          loadedSuccessfully = true
        } else {
          loadedSuccessfully = true
        }
      } finally {
        if (loadedSuccessfully) {
          isContentReadyRef.current = true
        }
        if (!cancelled && loadedSuccessfully) {
          if (onHeadingsChange) {
            const headings = extractHeadings(editor.document as Block[])
            onHeadingsChange(headings)
          }
          if (onInlineTagsChange) {
            const tags = extractInlineTags(editor.document as Block[])
            prevInlineTagsRef.current = tags
            onInlineTagsChange(tags)
          }
        }
      }
    }
    void loadContent()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  // Debounced change handler
  const handleChange = useCallback(() => {
    const blocks = editor.document

    const normalized = normalizeWikiLinks(blocks as Block[])
    if (normalized.didChange) {
      editor.replaceBlocks(editor.document, normalized.blocks)
      return
    }

    onContentChange?.(blocks as Block[])

    if (isRemoteUpdateRef?.current) return

    // When Yjs collaboration is active, the main-process CRDT doc owns body
    // persistence and writes merged markdown back to disk. Avoid racing that
    // writeback with a separate renderer-triggered markdown save.
    if (!yjsFragment && onMarkdownChange && isContentReadyRef.current) {
      if (markdownDebounceRef.current) {
        clearTimeout(markdownDebounceRef.current)
      }
      markdownDebounceRef.current = setTimeout(() => {
        void (async () => {
          try {
            const markdown = await serializeBlocksPreservingBlanks(
              editor,
              editor.document as Block[]
            )

            onMarkdownChange(markdown)
          } catch (error) {
            log.error('Failed to convert blocks to markdown', error)
          }
        })()
      }, 150)
    }

    if (onHeadingsChange) {
      if (headingsDebounceRef.current) {
        clearTimeout(headingsDebounceRef.current)
      }
      headingsDebounceRef.current = setTimeout(() => {
        const headings = extractHeadings(editor.document as Block[])
        onHeadingsChange(headings)
      }, 200)
    }

    if (onInlineTagsChange) {
      if (inlineTagsDebounceRef.current) clearTimeout(inlineTagsDebounceRef.current)
      inlineTagsDebounceRef.current = setTimeout(() => {
        const currentBlocks = editor.document as Block[]
        const tags = extractInlineTags(currentBlocks)
        const tagsKey = tags.sort().join(',')
        const prevKey = [...prevInlineTagsRef.current].sort().join(',')
        if (tagsKey !== prevKey) {
          prevInlineTagsRef.current = tags
          onInlineTagsChange(tags)
        }
      }, 300)
    }
  }, [
    editor,
    onContentChange,
    isRemoteUpdateRef,
    yjsFragment,
    onMarkdownChange,
    onHeadingsChange,
    onInlineTagsChange
  ])

  return { handleChange, isContentReadyRef, prevInlineTagsRef, lastNormalizedTagsRef }
}
