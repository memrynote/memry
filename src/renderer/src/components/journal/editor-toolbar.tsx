/**
 * Editor Toolbar Component
 * Toolbar with formatting buttons for the journal editor
 */

import { memo } from 'react'
import type { Editor } from '@tiptap/react'
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Link,
  Image,
  MoreHorizontal,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  CheckSquare,
  Quote,
  Minus,
  Code,
  Maximize2
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { createLogger } from '@/lib/logger'
import { Button } from '@/components/ui/button'

const log = createLogger('Component:EditorToolbar')
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

// =============================================================================
// TYPES
// =============================================================================

export interface EditorToolbarProps {
  editor: Editor | null
  className?: string
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Editor Toolbar - formatting buttons for Tiptap editor
 */
export const EditorToolbar = memo(function EditorToolbar({
  editor,
  className
}: EditorToolbarProps): React.JSX.Element | null {
  if (!editor) return null

  return (
    <div
      role="toolbar"
      aria-label="Text formatting"
      className={cn(
        'flex items-center gap-0.5 px-2 py-1.5 border-t border-border/50',
        'bg-muted/30',
        className
      )}
    >
      {/* Text Formatting Group */}
      <ToolbarGroup>
        <ToolbarButton
          icon={Bold}
          label="Bold"
          shortcut="⌘B"
          isActive={editor.isActive('bold')}
          onClick={() => editor.chain().focus().toggleBold().run()}
        />
        <ToolbarButton
          icon={Italic}
          label="Italic"
          shortcut="⌘I"
          isActive={editor.isActive('italic')}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        />
        <ToolbarButton
          icon={Underline}
          label="Underline"
          shortcut="⌘U"
          isActive={editor.isActive('underline')}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
        />
        <ToolbarButton
          icon={Strikethrough}
          label="Strikethrough"
          shortcut="⌘⇧S"
          isActive={editor.isActive('strike')}
          onClick={() => editor.chain().focus().toggleStrike().run()}
        />
      </ToolbarGroup>

      <ToolbarSeparator />

      {/* Media/Insert Group */}
      <ToolbarGroup>
        <ToolbarButton
          icon={Link}
          label="Link"
          shortcut="⌘K"
          isActive={editor.isActive('link')}
          onClick={() => {
            const url = window.prompt('Enter URL:')
            if (url) {
              editor.chain().focus().setLink({ href: url }).run()
            }
          }}
        />
        <ToolbarButton
          icon={Image}
          label="Image"
          onClick={() => {
            // TODO: Image upload - requires @tiptap/extension-image
            log.info('Image insert - coming soon')
          }}
        />
      </ToolbarGroup>

      <ToolbarSeparator />

      {/* More Options Dropdown */}
      <MoreOptionsMenu editor={editor} />

      <div className="flex-1" />

      {/* View Mode Toggle (placeholder) */}
      <ToolbarButton
        icon={Maximize2}
        label="Focus Mode"
        onClick={() => {
          // TODO: Toggle focus mode
          log.info('Focus mode toggle')
        }}
      />
    </div>
  )
})

// =============================================================================
// TOOLBAR COMPONENTS
// =============================================================================

interface ToolbarButtonProps {
  icon: React.ComponentType<{ className?: string }>
  label: string
  shortcut?: string
  isActive?: boolean
  disabled?: boolean
  onClick: () => void
}

function ToolbarButton({
  icon: Icon,
  label,
  shortcut,
  isActive = false,
  disabled = false,
  onClick
}: ToolbarButtonProps): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn('size-7', isActive && 'bg-accent text-accent-foreground')}
      onClick={onClick}
      disabled={disabled}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-pressed={isActive}
    >
      <Icon className="size-4" />
    </Button>
  )
}

function ToolbarGroup({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex items-center gap-0.5">{children}</div>
}

function ToolbarSeparator(): React.JSX.Element {
  return <div className="w-px h-5 bg-border mx-1" />
}

// =============================================================================
// MORE OPTIONS MENU
// =============================================================================

interface MoreOptionsMenuProps {
  editor: Editor
}

function MoreOptionsMenu({ editor }: MoreOptionsMenuProps): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="More options"
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        {/* Headings */}
        <DropdownMenuItem
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          className={cn(editor.isActive('heading', { level: 1 }) && 'bg-accent')}
        >
          <Heading1 className="size-4 mr-2" />
          Heading 1<span className="ml-auto text-xs text-muted-foreground">⌘⌥1</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          className={cn(editor.isActive('heading', { level: 2 }) && 'bg-accent')}
        >
          <Heading2 className="size-4 mr-2" />
          Heading 2<span className="ml-auto text-xs text-muted-foreground">⌘⌥2</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          className={cn(editor.isActive('heading', { level: 3 }) && 'bg-accent')}
        >
          <Heading3 className="size-4 mr-2" />
          Heading 3<span className="ml-auto text-xs text-muted-foreground">⌘⌥3</span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {/* Lists */}
        <DropdownMenuItem
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          className={cn(editor.isActive('bulletList') && 'bg-accent')}
        >
          <List className="size-4 mr-2" />
          Bullet List
          <span className="ml-auto text-xs text-muted-foreground">⌘⇧8</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          className={cn(editor.isActive('orderedList') && 'bg-accent')}
        >
          <ListOrdered className="size-4 mr-2" />
          Numbered List
          <span className="ml-auto text-xs text-muted-foreground">⌘⇧7</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => editor.chain().focus().toggleTaskList().run()}
          className={cn(editor.isActive('taskList') && 'bg-accent')}
          disabled
        >
          <CheckSquare className="size-4 mr-2" />
          Checklist
          <span className="ml-auto text-xs text-muted-foreground">⌘⇧9</span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {/* Blocks */}
        <DropdownMenuItem
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          className={cn(editor.isActive('blockquote') && 'bg-accent')}
        >
          <Quote className="size-4 mr-2" />
          Quote
          <span className="ml-auto text-xs text-muted-foreground">⌘⇧B</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => editor.chain().focus().setHorizontalRule().run()}>
          <Minus className="size-4 mr-2" />
          Divider
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          className={cn(editor.isActive('codeBlock') && 'bg-accent')}
        >
          <Code className="size-4 mr-2" />
          Code Block
          <span className="ml-auto text-xs text-muted-foreground">⌘⇧C</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default EditorToolbar
