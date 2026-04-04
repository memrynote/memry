/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useRef } from 'react'
import { type Block } from '@blocknote/core'
import type * as Y from 'yjs'
import {
  extractHeadings,
  normalizeWikiLinks,
  normalizeMarkdownHardBreaks
} from '../wiki-link-utils'
import { normalizeHashTags, extractInlineTags } from '../hash-tag'
import { FILE_BLOCK_REGEX, createFileBlockContent, serializeFileBlock } from '../file-block'
import { parseMarkdownPreservingBlanks, serializeBlocksPreservingBlanks } from '../markdown-utils'
import { createLinkMentionContent } from '../link-mention'
import { fetchLinkPreview } from '@/lib/url-metadata'
import type { HeadingInfo } from '../types'
import { createLogger } from '@/lib/logger'

const log = createLogger('Hook:EditorSync')

function hydrateLinkMentionFavicons(editor: any): void {
  const mentions: { block: any; index: number; url: string }[] = []

  const walk = (blocks: any[]): void => {
    for (const block of blocks) {
      const content = (block.content ?? []) as any[]
      content.forEach((c: any, i: number) => {
        if (c.type === 'linkMention' && c.props?.url && !c.props.favicon) {
          mentions.push({ block, index: i, url: c.props.url })
        }
      })
      if (block.children?.length) walk(block.children)
    }
  }

  walk(editor.document)

  for (const { block, index, url } of mentions) {
    fetchLinkPreview(url)
      .then((metadata) => {
        const current = (block.content ?? []) as any[]
        if (current[index]?.type !== 'linkMention') return
        const updated = [...current]
        updated[index] = createLinkMentionContent(
          url,
          metadata.domain || current[index].props.domain,
          metadata.title || current[index].props.title,
          metadata.favicon
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
  initialContent,
  contentType = 'html',
  yjsFragment,
  isRemoteUpdateRef,
  noteTags,
  tagColorMap,
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

  // Parse content on initial mount (uncontrolled component pattern)
  useEffect(() => {
    if (initialContentLoadedRef.current) {
      return
    }
    initialContentLoadedRef.current = true

    if (yjsFragment) {
      isContentReadyRef.current = true
      if (onHeadingsChange) {
        const headings = extractHeadings(editor.document as Block[])
        onHeadingsChange(headings)
      }
      return
    }

    async function loadContent(): Promise<void> {
      try {
        if (typeof initialContent === 'string' && initialContent.trim()) {
          try {
            let content = initialContent
            const fileBlocksToInsert: Array<{
              url: string
              name: string
              size: number
              mimeType: string
            }> = []

            if (contentType === 'markdown') {
              const matches = content.matchAll(FILE_BLOCK_REGEX)
              for (const match of matches) {
                try {
                  const props = JSON.parse(match[1])
                  fileBlocksToInsert.push(props)
                } catch {
                  // Skip invalid markers
                }
              }
              content = content.replace(FILE_BLOCK_REGEX, '').trim()
              content = normalizeMarkdownHardBreaks(content)
            }

            let blocks
            if (contentType === 'markdown') {
              blocks = await parseMarkdownPreservingBlanks(editor, content)
            } else {
              // eslint-disable-next-line @typescript-eslint/await-thenable -- BlockNote types are incorrect
              blocks = await editor.tryParseHTMLToBlocks(content)
            }

            if (fileBlocksToInsert.length > 0) {
              const fileBlocks = fileBlocksToInsert.map((props) => createFileBlockContent(props))
              blocks = [...blocks, ...fileBlocks]
            }

            let normalizedBlocks = normalizeWikiLinks(blocks).blocks

            if (noteTags?.length && tagColorMap) {
              const tagSet = new Set(noteTags.map((t) => t.toLowerCase()))
              const hashNormalized = normalizeHashTags(normalizedBlocks, tagSet, tagColorMap)
              normalizedBlocks = hashNormalized.blocks
              lastNormalizedTagsRef.current = noteTags.slice().sort().join(',')
            }

            editor.replaceBlocks(editor.document, normalizedBlocks)
            hydrateLinkMentionFavicons(editor)
          } catch (error) {
            log.error(`Failed to parse ${contentType} content`, error)
          }
        } else if (Array.isArray(initialContent) && initialContent.length > 0) {
          let normalizedBlocks = normalizeWikiLinks(initialContent).blocks

          if (noteTags?.length && tagColorMap) {
            const tagSet = new Set(noteTags.map((t) => t.toLowerCase()))
            const hashNormalized = normalizeHashTags(normalizedBlocks, tagSet, tagColorMap)
            normalizedBlocks = hashNormalized.blocks
            lastNormalizedTagsRef.current = noteTags.slice().sort().join(',')
          }

          editor.replaceBlocks(editor.document, normalizedBlocks)
        }
      } finally {
        isContentReadyRef.current = true
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
    void loadContent()
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

    if (onMarkdownChange && isContentReadyRef.current) {
      if (markdownDebounceRef.current) {
        clearTimeout(markdownDebounceRef.current)
      }
      markdownDebounceRef.current = setTimeout(async () => {
        try {
          let markdown = await serializeBlocksPreservingBlanks(editor, editor.document as Block[])

          const fileBlocks = (editor.document as Block[]).filter((b) => b.type === 'file')
          if (fileBlocks.length > 0) {
            const markers = fileBlocks.map((b) => {
              const props = b.props as unknown as {
                url: string
                name: string
                size: number
                mimeType: string
              }
              return serializeFileBlock(props)
            })
            markdown = markdown + '\n\n' + markers.join('\n')
          }

          onMarkdownChange(markdown)
        } catch (error) {
          log.error('Failed to convert blocks to markdown', error)
        }
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
    onMarkdownChange,
    onHeadingsChange,
    onInlineTagsChange,
    isRemoteUpdateRef
  ])

  return { handleChange, isContentReadyRef, prevInlineTagsRef, lastNormalizedTagsRef }
}
