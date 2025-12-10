/**
 * Floating Toolbar Component
 * Selection-aware toolbar for text formatting
 */

import { memo, useEffect, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { Bold, Italic, Strikethrough, Link, Code, Quote } from 'lucide-react'
import { cn } from '@/lib/utils'

// =============================================================================
// TYPES
// =============================================================================

export interface FloatingToolbarProps {
  editor: Editor | null
  className?: string
}

interface ToolbarButtonProps {
  icon: React.ComponentType<{ className?: string }>
  label: string
  isActive?: boolean
  onClick: () => void
}

interface ToolbarPosition {
  top: number
  left: number
  visible: boolean
}

// =============================================================================
// TOOLBAR BUTTON
// =============================================================================

/**
 * Single toolbar button with icon
 */
function ToolbarButton({ icon: Icon, label, isActive = false, onClick }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center justify-center',
        'w-7 h-7 rounded',
        'text-white transition-colors duration-100',
        'hover:bg-white/10',
        isActive && 'bg-white/20'
      )}
      title={label}
      aria-label={label}
      aria-pressed={isActive}
    >
      <Icon className="w-4 h-4" />
    </button>
  )
}

/**
 * Separator between button groups
 */
function ToolbarSeparator() {
  return <div className="w-px h-5 bg-white/20 mx-1" />
}

// =============================================================================
// FLOATING TOOLBAR
// =============================================================================

/**
 * FloatingToolbar - Appears above selected text
 *
 * Essential formatting buttons:
 * - Bold, Italic, Strikethrough
 * - Link, Inline Code
 * - Blockquote
 *
 * Design specs:
 * - Dark background (#1c1917)
 * - White icons
 * - Position: above selected text
 */
export const FloatingToolbar = memo(function FloatingToolbar({
  editor,
  className
}: FloatingToolbarProps) {
  const [position, setPosition] = useState<ToolbarPosition>({
    top: 0,
    left: 0,
    visible: false
  })

  // Update toolbar position based on selection
  useEffect(() => {
    if (!editor) return

    const updatePosition = () => {
      const { selection } = editor.state
      const { empty } = selection

      // Hide if selection is empty or in code block
      if (empty || editor.isActive('codeBlock')) {
        setPosition((prev) => ({ ...prev, visible: false }))
        return
      }

      // Get selection coordinates
      const { from, to } = selection
      const start = editor.view.coordsAtPos(from)
      const end = editor.view.coordsAtPos(to)

      // Calculate center position above selection
      const left = (start.left + end.left) / 2
      const top = start.top - 45 // 45px above selection

      setPosition({
        top,
        left,
        visible: true
      })
    }

    // Listen to selection changes
    editor.on('selectionUpdate', updatePosition)
    editor.on('blur', () => setPosition((prev) => ({ ...prev, visible: false })))

    return () => {
      editor.off('selectionUpdate', updatePosition)
    }
  }, [editor])

  // Don't render if no editor or not visible
  if (!editor || !position.visible) {
    return null
  }

  // Link handler
  const handleLinkClick = () => {
    // If already has link, remove it
    if (editor.isActive('link')) {
      editor.chain().focus().unsetLink().run()
      return
    }

    // Prompt for URL
    const url = window.prompt('Enter URL:')
    if (url) {
      editor.chain().focus().setLink({ href: url }).run()
    }
  }

  return (
    <div
      role="toolbar"
      aria-label="Text formatting"
      className={cn(
        'fixed z-50',
        'flex items-center gap-0.5 px-2 py-1',
        'bg-stone-900 rounded-lg',
        'shadow-lg',
        'animate-in fade-in-0 zoom-in-95 duration-100',
        className
      )}
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
        transform: 'translateX(-50%)'
      }}
    >
      {/* Text Formatting */}
      <ToolbarButton
        icon={Bold}
        label="Bold (Cmd+B)"
        isActive={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()}
      />
      <ToolbarButton
        icon={Italic}
        label="Italic (Cmd+I)"
        isActive={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      />
      <ToolbarButton
        icon={Strikethrough}
        label="Strikethrough (Cmd+Shift+S)"
        isActive={editor.isActive('strike')}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      />

      <ToolbarSeparator />

      {/* Link and Code */}
      <ToolbarButton
        icon={Link}
        label="Link (Cmd+K)"
        isActive={editor.isActive('link')}
        onClick={handleLinkClick}
      />
      <ToolbarButton
        icon={Code}
        label="Inline Code (Cmd+E)"
        isActive={editor.isActive('code')}
        onClick={() => editor.chain().focus().toggleCode().run()}
      />

      <ToolbarSeparator />

      {/* Block Quote */}
      <ToolbarButton
        icon={Quote}
        label="Blockquote"
        isActive={editor.isActive('blockquote')}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      />
    </div>
  )
})

export default FloatingToolbar
