/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useRef } from 'react'
import { createHashTagInlinePlugin } from '../hash-tag-inline-plugin'
import { useSidebarDrillDown } from '@/contexts/sidebar-drill-down'

interface TagSuggestionsParams {
  editor: any
  editorContainerRef: React.RefObject<HTMLDivElement | null>
  tagColorMap?: Map<string, string>
}

interface TagSuggestionsResult {
  getTagColor: (tag: string) => string
  handleTagSuggestionSelect: (tag: string, color: string, nodePos: number) => void
}

export function useTagSuggestions({
  editor,
  editorContainerRef,
  tagColorMap
}: TagSuggestionsParams): TagSuggestionsResult {
  const { openTag } = useSidebarDrillDown()
  const tagColorMapRef = useRef(tagColorMap)

  // Keep ref in sync
  useEffect(() => {
    tagColorMapRef.current = tagColorMap
  }, [tagColorMap])

  const getTagColor = useCallback((tag: string): string => {
    return tagColorMapRef.current?.get(tag) || 'stone'
  }, [])

  // Register hashTag inline plugin on editor's tiptap instance
  useEffect(() => {
    const tiptap = (editor as any)._tiptapEditor
    if (!tiptap) return

    const plugin = createHashTagInlinePlugin(getTagColor)
    tiptap.registerPlugin(plugin)

    return () => {
      tiptap.unregisterPlugin(plugin.spec.key!)
    }
  }, [editor, getTagColor])

  // Re-color existing hashTag nodes when tagColorMap changes
  useEffect(() => {
    if (!tagColorMap || tagColorMap.size === 0) return

    const tiptap = (editor as any)._tiptapEditor
    if (!tiptap) return

    const { state } = tiptap
    let tr = state.tr
    let changed = false

    state.doc.descendants((node: any, pos: number) => {
      if (node.type.name === 'hashTag') {
        const correctColor = tagColorMap.get(node.attrs.tag as string) || 'stone'
        if (node.attrs.color !== correctColor) {
          tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, color: correctColor })
          changed = true
        }
      }
    })

    if (changed) {
      tiptap.view.dispatch(tr)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, tagColorMap])

  // Tag pill click handler — navigates to tag drill-down
  useEffect(() => {
    const container = editorContainerRef.current
    if (!container) return

    const handleTagClick = (e: MouseEvent) => {
      const pill = (e.target as HTMLElement).closest<HTMLElement>('.inline-hash-tag')
      if (!pill) return

      const tag = pill.dataset.hashTag
      const color = pill.dataset.hashTagColor || 'stone'
      if (tag) openTag(tag, color)
    }

    container.addEventListener('click', handleTagClick)
    return () => container.removeEventListener('click', handleTagClick)
  }, [openTag, editorContainerRef])

  const handleTagSuggestionSelect = useCallback(
    (tag: string, color: string, nodePos: number) => {
      const tiptap = (editor as any)._tiptapEditor
      if (!tiptap) return

      const hashTagNodeType = tiptap.state.schema.nodes.hashTag
      if (!hashTagNodeType) return

      const oldNode = tiptap.state.doc.nodeAt(nodePos)
      if (!oldNode || oldNode.type.name !== 'hashTag') return

      const newNode = hashTagNodeType.create({ tag, color })
      const tr = tiptap.state.tr.replaceWith(nodePos, nodePos + oldNode.nodeSize, newNode)
      tiptap.view.dispatch(tr)
    },
    [editor]
  )

  return { getTagColor, handleTagSuggestionSelect }
}
