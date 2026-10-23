/* oxlint-disable typescript/no-explicit-any */

import { foldTag } from '@memry/shared/tag-fold'
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
  onTagClick?: (tag: string, pill: HTMLElement) => boolean
}

interface TagSuggestionsResult {
  getTagColor: (tag: string) => string
  handleTagSuggestionSelect: (tag: string, color: string, nodePos: number) => void
}

export function useTagSuggestions({
  editor,
  editorContainerRef,
  tagColorMap,
  tagIconMap,
  onTagClick
}: TagSuggestionsParams): TagSuggestionsResult {
  const { openSidebarItem } = useSidebarNavigation()
  const onTagClickRef = useRef(onTagClick)
  useEffect(() => {
    onTagClickRef.current = onTagClick
  }, [onTagClick])
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
    return tagColorMapRef.current?.get(foldTag(tag)) || defaultTagColorName(tag)
  }, [])

  // Register hashTag inline plugin on editor's tiptap instance
  useEffect(() => {
    const plugin = createHashTagInlinePlugin(getTagColor)
    return registerEditorPlugin(editor, plugin)
  }, [editor, getTagColor])

  // Re-color + re-icon existing hashTag nodes from the current tag maps. Runs
  // when the maps change and on every doc change: a tag rename rewrites the
  // open note's chips after the maps already moved on, so the chip arrives
  // with the old tag's stored color/icon (#3051).
  useLayoutEffect(() => {
    const tiptap = editor._tiptapEditor
    if (!tiptap) return

    const reconcile = (): void => {
      const colorMap = tagColorMapRef.current
      if (!colorMap || colorMap.size === 0) return
      const iconMap = tagIconMapRef.current

      const { state } = tiptap
      let tr = state.tr
      let changed = false

      state.doc.descendants((node: any, pos: number) => {
        if (node.type.name === 'hashTag') {
          const tagKey = foldTag(node.attrs.tag as string)
          const correctColor = colorMap.get(tagKey) || defaultTagColorName(node.attrs.tag as string)
          const correctIcon = iconMap?.get(tagKey) ?? ''
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
    }

    tagColorMapRef.current = tagColorMap
    tagIconMapRef.current = tagIconMap
    reconcile()
    const onUpdate = ({ transaction }: { transaction: any }): void => {
      if (transaction.docChanged) reconcile()
    }
    tiptap.on('update', onUpdate)
    return () => {
      tiptap.off('update', onUpdate)
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
      if (tag && onTagClickRef.current?.(tag, pill)) return
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
    return () => {
      container.removeEventListener('click', handleTagClick)
    }
  }, [openSidebarItem, editorContainerRef])

  const handleTagSuggestionSelect = useCallback(
    (tag: string, color: string, nodePos: number) => {
      const tiptap = editor._tiptapEditor
      if (!tiptap) return

      const hashTagNodeType = tiptap.state.schema.nodes.hashTag
      if (!hashTagNodeType) return

      const oldNode = tiptap.state.doc.nodeAt(nodePos)
      if (!oldNode || oldNode.type.name !== 'hashTag') return

      const icon = tagIconMapRef.current?.get(foldTag(tag)) ?? ''
      const newNode = hashTagNodeType.create({ tag, color, icon })
      const tr = tiptap.state.tr.replaceWith(nodePos, nodePos + oldNode.nodeSize, newNode)
      tiptap.view.dispatch(tr)
    },
    [editor]
  )

  return { getTagColor, handleTagSuggestionSelect }
}
