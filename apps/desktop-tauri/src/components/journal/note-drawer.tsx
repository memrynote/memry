/**
 * Note Drawer Component
 * Slides over the right sidebar to show note content
 */

import { useEffect, useRef, useCallback, memo } from 'react'
import {
  X,
  ExternalLink,
  FileText,
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Link,
  Image
} from '@/lib/icons'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { Note } from './notes-section'

// =============================================================================
// TYPES
// =============================================================================

export interface NoteDrawerProps {
  /** Note to display */
  note: Note | null
  /** Whether drawer is open */
  isOpen: boolean
  /** Close drawer callback */
  onClose: () => void
  /** Open in full page callback */
  onOpenFullPage?: (noteId: string) => void
  /** Additional CSS classes */
  className?: string
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Note Drawer - slides over the right sidebar
 * Shows note content with editor
 */
export const NoteDrawer = memo(function NoteDrawer({
  note,
  isOpen,
  onClose,
  onOpenFullPage,
  className
}: NoteDrawerProps): React.JSX.Element | null {
  const drawerRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  // Handle escape key to close
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && isOpen) {
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  // Focus close button when drawer opens
  useEffect(() => {
    if (isOpen && closeButtonRef.current) {
      // Small delay to allow animation to start
      setTimeout(() => closeButtonRef.current?.focus(), 100)
    }
  }, [isOpen])

  // Handle click outside
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose()
      }
    },
    [onClose]
  )

  const handleOpenFullPage = useCallback(() => {
    if (note && onOpenFullPage) {
      onOpenFullPage(note.id)
    }
  }, [note, onOpenFullPage])

  return (
    <>
      {/* Backdrop (click to close) */}
      {isOpen && (
        <div className="fixed inset-0 z-40" onClick={handleBackdropClick} aria-hidden="true" />
      )}

      {/* Drawer */}
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        aria-hidden={!isOpen}
        className={cn(
          'fixed top-0 right-0 bottom-0 z-50',
          'w-[40vw] min-w-[360px] max-w-[600px]',
          'bg-card border-l border-border',
          'shadow-[-4px_0_20px_rgba(0,0,0,0.15)]',
          'flex flex-col',
          'transform transition-transform duration-250 ease-out',
          isOpen ? 'translate-x-0' : 'translate-x-full',
          className
        )}
      >
        {note && (
          <>
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <FileText className="size-4 text-muted-foreground shrink-0" />
                <h2 id="drawer-title" className="text-sm font-semibold text-foreground truncate">
                  {note.title}
                </h2>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  onClick={handleOpenFullPage}
                  aria-label="Open note in full page"
                >
                  <ExternalLink className="size-4" />
                </Button>
                <Button
                  ref={closeButtonRef}
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  onClick={onClose}
                  aria-label="Close note drawer"
                >
                  <X className="size-4" />
                </Button>
              </div>
            </div>

            {/* Content (Editor placeholder) */}
            <div className="flex-1 overflow-y-auto p-4">
              <div className="prose prose-sm dark:prose-invert max-w-none">
                {note.content ? (
                  <div dangerouslySetInnerHTML={{ __html: note.content }} />
                ) : (
                  <p className="text-muted-foreground italic">
                    {note.preview || 'Start writing...'}
                  </p>
                )}
              </div>
            </div>

            {/* Toolbar */}
            <div className="px-4 py-2 border-t border-border shrink-0 flex items-center justify-between">
              <div className="flex items-center gap-1">
                <ToolbarButton title="Bold">
                  <Bold className="size-3.5" />
                </ToolbarButton>
                <ToolbarButton title="Italic">
                  <Italic className="size-3.5" />
                </ToolbarButton>
                <ToolbarButton title="Underline">
                  <Underline className="size-3.5" />
                </ToolbarButton>
                <ToolbarButton title="Strikethrough">
                  <Strikethrough className="size-3.5" />
                </ToolbarButton>
                <span className="w-px h-4 bg-border mx-1" />
                <ToolbarButton title="Link">
                  <Link className="size-3.5" />
                </ToolbarButton>
                <ToolbarButton title="Image">
                  <Image className="size-3.5" />
                </ToolbarButton>
              </div>
              <div className="flex items-center gap-1">
                <ToolbarButton title="More options">⋮</ToolbarButton>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  )
})

// =============================================================================
// TOOLBAR BUTTON
// =============================================================================

function ToolbarButton({
  children,
  title
}: {
  children: React.ReactNode
  title?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      className={cn(
        'size-7 flex items-center justify-center rounded',
        'text-xs text-muted-foreground',
        'hover:bg-muted/50 transition-colors'
      )}
    >
      {children}
    </button>
  )
}

export default NoteDrawer
