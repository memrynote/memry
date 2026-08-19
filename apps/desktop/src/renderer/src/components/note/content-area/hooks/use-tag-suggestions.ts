/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { createHashTagInlinePlugin } from '../hash-tag-inline-plugin'
import { registerEditorPlugin } from '../register-editor-plugin'
import { defaultTagColorName } from '@/components/note/tags-row/tag-colors'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'

interface TagSuggestionsParams {
  editor: any
  editorContainerRef: React.RefObject<HTMLDivElement | null>
  tagColorMap?: Map<string, string>
  tagIconMap?: Map<string, string>
}

interface TagSuggestionsResult {
  getTagColor: (tag: string) => string
  handleTagSuggestionSelect: (tag: string, color: string, nodePos: number) => void
}

export function useTagSuggestions({
  editor,
  editorContainerRef,
  tagColorMap,
  tagIconMap
}: TagSuggestionsParams): TagSuggestionsResult {
  const { openSidebarItem } = useSidebarNavigation()
  const tagColorMapRef = useRef(tagColorMap)
  const tagIconMapRef = useRef(tagIconMap)

  // Keep refs in sync
  useEffect(() => {
    tagColorMapRef.current = tagColorMap
    tagIconMapRef.current = tagIconMap
  }, [tagColorMap, tagIconMap])

  const getTagColor = useCallback((tag: string): string => {
    // Fall back to a deterministic palette color derived from the tag name
    // (instead of a flat grey) when the tag has no explicit color yet.
    // Maps are keyed by lowercase; tag identity is case-insensitive.
    return tagColorMapRef.current?.get(tag.toLowerCase()) || defaultTagColorName(tag)
  }, [])

  // Register hashTag inline plugin on editor's tiptap instance
  useEffect(() => {
    const plugin = createHashTagInlinePlugin(getTagColor)
    return registerEditorPlugin(editor, plugin)
  }, [editor, getTagColor])

  // Re-color + re-icon existing hashTag nodes when the tag color/icon maps
  // change. Pure DOM/editor mutation — useLayoutEffect runs after layout but
  // before paint, which is appropriate here and avoids the
  // no-pass-data-to-parent false positive.
  useLayoutEffect(() => {
    if (!tagColorMap || tagColorMap.size === 0) return

    const tiptap = editor._tiptapEditor
    if (!tiptap) return

    const { state } = tiptap
    let tr = state.tr
    let changed = false

    state.doc.descendants((node: any, pos: number) => {
      if (node.type.name === 'hashTag') {
        const tagKey = (node.attrs.tag as string).toLowerCase()
        const correctColor =
          tagColorMap.get(tagKey) || defaultTagColorName(node.attrs.tag as string)
        const correctIcon = tagIconMap?.get(tagKey) ?? ''
        if (node.attrs.color !== correctColor || (node.attrs.icon ?? '') !== correctIcon) {
          tr = tr.setNodeMarkup(pos, undefined, {
            ...node.attrs,
            color: correctColor,
            icon: correctIcon
          })
          changed = true
        }
      }
    })

    if (changed) {
      tiptap.view.dispatch(tr)
    }
  }, [editor, tagColorMap, tagIconMap])

  // Tag pill click handler — navigates to tag drill-down
  useEffect(() => {
    const container = editorContainerRef.current
    if (!container) return

    const handleTagClick = (e: MouseEvent) => {
      const pill = (e.target as HTMLElement).closest<HTMLElement>('.inline-hash-tag')
      if (!pill) return

      const tag = pill.dataset.hashTag
      const color = pill.dataset.hashTagColor || ''
      if (tag) {
        openSidebarItem({
          type: 'tag',
          title: tag,
          path: '/tags/' + tag,
          entityId: tag,
          color
        })
      }
    }

    container.addEventListener('click', handleTagClick)
    return () => container.removeEventListener('click', handleTagClick)
  }, [openSidebarItem, editorContainerRef])

  const handleTagSuggestionSelect = useCallback(
    (tag: string, color: string, nodePos: number) => {
      const tiptap = editor._tiptapEditor
      if (!tiptap) return

      const hashTagNodeType = tiptap.state.schema.nodes.hashTag
      if (!hashTagNodeType) return

      const oldNode = tiptap.state.doc.nodeAt(nodePos)
      if (!oldNode || oldNode.type.name !== 'hashTag') return

      const icon = tagIconMapRef.current?.get(tag.toLowerCase()) ?? ''
      const newNode = hashTagNodeType.create({ tag, color, icon })
      const tr = tiptap.state.tr.replaceWith(nodePos, nodePos + oldNode.nodeSize, newNode)
      tiptap.view.dispatch(tr)
    },
    [editor]
  )

  return { getTagColor, handleTagSuggestionSelect }
}
