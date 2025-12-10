/**
 * Slash Command Menu Component
 * Dropdown menu for "/" triggered commands
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
  useCallback,
  useMemo,
  type KeyboardEvent
} from 'react'
import type { Editor } from '@tiptap/react'
import type { SuggestionProps } from '@tiptap/suggestion'
import {
  Pilcrow,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  CheckSquare,
  Image,
  Quote,
  Minus,
  Code,
  Lightbulb,
  Table
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SlashCommandItem, SlashCommandGroupConfig } from './types'

// =============================================================================
// SLASH COMMAND DEFINITIONS
// =============================================================================

/**
 * All available slash commands organized by group
 */
export const SLASH_COMMAND_GROUPS: SlashCommandGroupConfig[] = [
  {
    id: 'basic',
    label: 'BASIC BLOCKS',
    items: [
      {
        id: 'paragraph',
        title: 'Paragraph',
        description: 'Text block',
        icon: Pilcrow,
        aliases: ['text', 'p'],
        group: 'basic',
        command: (editor) => editor.chain().focus().setParagraph().run()
      },
      {
        id: 'heading1',
        title: 'Heading 1',
        description: 'Large heading',
        icon: Heading1,
        aliases: ['h1', 'title'],
        group: 'basic',
        command: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run()
      },
      {
        id: 'heading2',
        title: 'Heading 2',
        description: 'Medium heading',
        icon: Heading2,
        aliases: ['h2', 'subtitle'],
        group: 'basic',
        command: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run()
      },
      {
        id: 'heading3',
        title: 'Heading 3',
        description: 'Small heading',
        icon: Heading3,
        aliases: ['h3'],
        group: 'basic',
        command: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run()
      }
    ]
  },
  {
    id: 'lists',
    label: 'LISTS',
    items: [
      {
        id: 'bulletList',
        title: 'Bullet List',
        description: 'Simple list',
        icon: List,
        aliases: ['ul', 'unordered'],
        group: 'lists',
        command: (editor) => editor.chain().focus().toggleBulletList().run()
      },
      {
        id: 'numberedList',
        title: 'Numbered List',
        description: 'Ordered list',
        icon: ListOrdered,
        aliases: ['ol', 'ordered', 'number'],
        group: 'lists',
        command: (editor) => editor.chain().focus().toggleOrderedList().run()
      },
      {
        id: 'taskList',
        title: 'Task List',
        description: 'Checkboxes',
        icon: CheckSquare,
        aliases: ['todo', 'checkbox', 'checklist'],
        group: 'lists',
        command: (editor) => editor.chain().focus().toggleTaskList().run()
      }
    ]
  },
  {
    id: 'media',
    label: 'MEDIA',
    items: [
      {
        id: 'image',
        title: 'Image',
        description: 'Upload or embed',
        icon: Image,
        aliases: ['img', 'picture', 'photo'],
        group: 'media',
        command: (editor) => {
          const url = window.prompt('Enter image URL:')
          if (url) {
            editor.chain().focus().setImage({ src: url }).run()
          }
        }
      }
    ]
  },
  {
    id: 'advanced',
    label: 'ADVANCED',
    items: [
      {
        id: 'blockquote',
        title: 'Blockquote',
        description: 'Quote text',
        icon: Quote,
        aliases: ['quote', 'citation'],
        group: 'advanced',
        command: (editor) => editor.chain().focus().toggleBlockquote().run()
      },
      {
        id: 'divider',
        title: 'Divider',
        description: 'Horizontal line',
        icon: Minus,
        aliases: ['hr', 'separator', 'line'],
        group: 'advanced',
        command: (editor) => editor.chain().focus().setHorizontalRule().run()
      },
      {
        id: 'codeBlock',
        title: 'Code Block',
        description: 'Code snippet',
        icon: Code,
        aliases: ['code', 'pre', 'snippet'],
        group: 'advanced',
        command: (editor) => editor.chain().focus().toggleCodeBlock().run()
      },
      {
        id: 'callout',
        title: 'Callout',
        description: 'Highlighted box',
        icon: Lightbulb,
        aliases: ['note', 'info', 'warning', 'alert'],
        group: 'advanced',
        command: (editor) => editor.chain().focus().setCallout('info').run()
      },
      {
        id: 'table',
        title: 'Table',
        description: 'Insert table',
        icon: Table,
        aliases: ['grid'],
        group: 'advanced',
        command: (editor) =>
          editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
      }
    ]
  }
]

/**
 * Flatten all commands into a single array
 */
export function getAllSlashCommands(): SlashCommandItem[] {
  return SLASH_COMMAND_GROUPS.flatMap((group) => group.items)
}

/**
 * Filter commands by query string
 */
export function filterSlashCommands(query: string): SlashCommandItem[] {
  const lowerQuery = query.toLowerCase()

  if (!lowerQuery) {
    return getAllSlashCommands()
  }

  return getAllSlashCommands().filter((item) => {
    const titleMatch = item.title.toLowerCase().includes(lowerQuery)
    const descMatch = item.description.toLowerCase().includes(lowerQuery)
    const aliasMatch = item.aliases?.some((alias) => alias.toLowerCase().includes(lowerQuery))

    return titleMatch || descMatch || aliasMatch
  })
}

// =============================================================================
// COMPONENT TYPES
// =============================================================================

export interface SlashCommandMenuProps {
  items: SlashCommandItem[]
  command: (item: SlashCommandItem) => void
  editor: Editor
}

export interface SlashCommandMenuRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * SlashCommandMenu - Dropdown menu for slash commands
 *
 * Design specs:
 * - Width: 280px
 * - Max-height: 360px (scrollable)
 * - Background: white
 * - Border: 1px solid #e7e5e4
 * - Border-radius: 12px
 * - Box-shadow: 0 4px 16px rgba(0,0,0,0.12)
 */
export const SlashCommandMenu = forwardRef<
  SlashCommandMenuRef,
  SlashCommandMenuProps & Partial<SuggestionProps>
>(({ items, command }, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0)

  // Reset selection when items change
  useEffect(() => {
    setSelectedIndex(0)
  }, [items])

  // Scroll selected item into view
  useEffect(() => {
    const selectedElement = document.querySelector('.slash-command-item-selected')
    if (selectedElement) {
      selectedElement.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  // Group items by their group property
  const groupedItems = useMemo(() => {
    const groups: Record<string, SlashCommandItem[]> = {}

    items.forEach((item) => {
      if (!groups[item.group]) {
        groups[item.group] = []
      }
      groups[item.group].push(item)
    })

    // Return in the order defined by SLASH_COMMAND_GROUPS
    return SLASH_COMMAND_GROUPS.filter((g) => groups[g.id]?.length > 0).map((g) => ({
      ...g,
      items: groups[g.id]
    }))
  }, [items])

  // Calculate flat index for keyboard navigation
  const flatItems = useMemo(() => items, [items])

  const selectItem = useCallback(
    (index: number) => {
      const item = flatItems[index]
      if (item) {
        command(item)
      }
    },
    [flatItems, command]
  )

  const upHandler = useCallback(() => {
    setSelectedIndex((prev) => (prev <= 0 ? flatItems.length - 1 : prev - 1))
  }, [flatItems.length])

  const downHandler = useCallback(() => {
    setSelectedIndex((prev) => (prev >= flatItems.length - 1 ? 0 : prev + 1))
  }, [flatItems.length])

  const enterHandler = useCallback(() => {
    selectItem(selectedIndex)
  }, [selectedIndex, selectItem])

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }: { event: KeyboardEvent }) => {
      if (event.key === 'ArrowUp') {
        upHandler()
        return true
      }

      if (event.key === 'ArrowDown') {
        downHandler()
        return true
      }

      if (event.key === 'Enter' || event.key === 'Tab') {
        enterHandler()
        return true
      }

      return false
    }
  }))

  // Track running index for selection
  let runningIndex = 0

  return (
    <div
      className={cn(
        'slash-command-menu',
        'z-50 w-[280px] max-h-[360px]',
        'overflow-y-auto rounded-xl border border-stone-200 bg-white',
        'shadow-lg p-1',
        'animate-in fade-in-0 zoom-in-95'
      )}
      role="listbox"
      aria-label="Slash commands"
    >
      {items.length === 0 ? (
        <div className="px-3 py-6 text-center text-sm text-stone-500">No commands found</div>
      ) : (
        groupedItems.map((group) => (
          <div key={group.id} className="mb-1 last:mb-0">
            {/* Group Label */}
            <div className="px-2 py-1.5 text-xs font-semibold text-stone-400 uppercase tracking-wider">
              {group.label}
            </div>

            {/* Group Items */}
            {group.items.map((item) => {
              const index = runningIndex++
              const isSelected = index === selectedIndex
              const Icon = item.icon

              return (
                <button
                  key={item.id}
                  className={cn(
                    'slash-command-item',
                    'relative flex w-full cursor-pointer select-none items-center gap-3',
                    'rounded-lg px-2 py-2 text-sm outline-none',
                    'hover:bg-stone-100',
                    isSelected && 'bg-stone-100 slash-command-item-selected'
                  )}
                  onClick={() => selectItem(index)}
                  role="option"
                  aria-selected={isSelected}
                >
                  <div
                    className={cn(
                      'flex h-10 w-10 shrink-0 items-center justify-center',
                      'rounded-lg border border-stone-200 bg-white'
                    )}
                  >
                    <Icon className="h-5 w-5 text-stone-600" />
                  </div>
                  <div className="flex flex-col items-start">
                    <span className="font-medium text-stone-900">{item.title}</span>
                    <span className="text-xs text-stone-500">{item.description}</span>
                  </div>
                </button>
              )
            })}
          </div>
        ))
      )}
    </div>
  )
})

SlashCommandMenu.displayName = 'SlashCommandMenu'

export default SlashCommandMenu
