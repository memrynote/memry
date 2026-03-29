import { useState, useEffect, useRef, useCallback } from 'react'
import { cn } from '@/lib/utils'
import { getTagColors } from '@/components/note/tags-row/tag-colors'
import { notesService } from '@/services/notes-service'
import { createLogger } from '@/lib/logger'

const log = createLogger('TagSuggestion')

interface TagSuggestion {
  tag: string
  color: string
  count: number
}

interface TagSuggestionPopoverProps {
  editor: any
  editorContainerRef: React.RefObject<HTMLDivElement | null>
  onSelect: (tag: string, color: string, nodePos: number) => void
}

export function TagSuggestionPopover({
  editor,
  editorContainerRef,
  onSelect
}: TagSuggestionPopoverProps) {
  const [visible, setVisible] = useState(false)
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const [activeTagName, setActiveTagName] = useState('')
  const [activeTagPos, setActiveTagPos] = useState(-1)
  const cacheRef = useRef<{ tags: TagSuggestion[]; fetchedAt: number } | null>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  const fetchTags = useCallback(async (): Promise<TagSuggestion[]> => {
    const now = Date.now()
    const cache = cacheRef.current
    if (cache && now - cache.fetchedAt < 5000) return cache.tags

    try {
      const result = await notesService.getTags()
      const tags = result.map((t) => ({ tag: t.tag, color: t.color, count: t.count }))
      cacheRef.current = { tags, fetchedAt: now }
      return tags
    } catch (error) {
      log.error('Failed to fetch tags', error)
      return cacheRef.current?.tags ?? []
    }
  }, [])

  useEffect(() => {
    const tiptap = (editor as any)?._tiptapEditor
    if (!tiptap) return

    const handleUpdate = () => {
      const { state } = tiptap
      const { $from } = state.selection

      if ($from.parentOffset === 0 || state.selection.from !== state.selection.to) {
        setVisible(false)
        return
      }

      const nodeBefore = $from.nodeBefore
      if (!nodeBefore || nodeBefore.type.name !== 'hashTag') {
        setVisible(false)
        return
      }

      const tagName = nodeBefore.attrs.tag as string
      const tagPos = $from.pos - nodeBefore.nodeSize

      setActiveTagName(tagName)
      setActiveTagPos(tagPos)

      void fetchTags().then((allTags) => {
        const filtered = allTags
          .filter((t) => t.tag.includes(tagName) && t.tag !== tagName)
          .sort((a, b) => {
            const aStarts = a.tag.startsWith(tagName)
            const bStarts = b.tag.startsWith(tagName)
            if (aStarts && !bStarts) return -1
            if (!aStarts && bStarts) return 1
            return b.count - a.count
          })
          .slice(0, 8)

        if (filtered.length === 0) {
          setVisible(false)
          return
        }

        setSuggestions(filtered)
        setSelectedIndex(0)
        setVisible(true)

        const container = editorContainerRef.current
        if (!container) return

        const pillEl = container.querySelector(`.inline-hash-tag[data-hash-tag="${tagName}"]`)
        if (pillEl) {
          const pillRect = pillEl.getBoundingClientRect()
          const containerRect = container.getBoundingClientRect()
          setPosition({
            top: pillRect.bottom - containerRect.top + 4,
            left: pillRect.left - containerRect.left
          })
        }
      })
    }

    tiptap.on('selectionUpdate', handleUpdate)
    tiptap.on('update', handleUpdate)

    return () => {
      tiptap.off('selectionUpdate', handleUpdate)
      tiptap.off('update', handleUpdate)
    }
  }, [editor, editorContainerRef, fetchTags])

  useEffect(() => {
    if (!visible) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((i) => (i + 1) % suggestions.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((i) => (i - 1 + suggestions.length) % suggestions.length)
      } else if ((e.key === 'Enter' || e.key === 'Tab') && suggestions.length > 0) {
        e.preventDefault()
        e.stopPropagation()
        const item = suggestions[selectedIndex]
        onSelect(item.tag, item.color, activeTagPos)
        setVisible(false)
      } else if (e.key === 'Escape') {
        setVisible(false)
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [visible, suggestions, selectedIndex, onSelect, activeTagPos])

  if (!visible || !position || suggestions.length === 0) return null

  return (
    <div
      ref={popoverRef}
      className={cn(
        'absolute z-50 min-w-[200px] max-w-[300px] max-h-[240px]',
        'overflow-y-auto rounded-md border bg-popover p-1',
        'shadow-md animate-in fade-in-0 zoom-in-95'
      )}
      style={{ top: position.top, left: position.left }}
      role="listbox"
      aria-label="Tag suggestions"
    >
      {suggestions.map((item, index) => {
        const isSelected = selectedIndex === index
        const colors = getTagColors(item.color)

        return (
          <button
            key={item.tag}
            className={cn(
              'flex w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none',
              'hover:bg-accent hover:text-accent-foreground',
              isSelected && 'bg-accent text-accent-foreground'
            )}
            onClick={() => {
              onSelect(item.tag, item.color, activeTagPos)
              setVisible(false)
            }}
            onMouseEnter={() => setSelectedIndex(index)}
            role="option"
            aria-selected={isSelected}
          >
            <span
              className="h-3 w-3 shrink-0 rounded-full"
              style={{ backgroundColor: colors.text }}
            />
            <span className="flex-1 font-medium text-left">#{item.tag}</span>
            <span className="text-xs text-muted-foreground">({item.count})</span>
          </button>
        )
      })}
    </div>
  )
}
