import { useCallback, useRef, useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Folder, FolderOpen, ArrowRight } from '@/lib/icons'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { EmojiPicker } from '@/components/note/note-title/EmojiPicker'
import { cn } from '@/lib/utils'

interface FolderIconButtonProps {
  icon: string | null
  isExpanded: boolean
  hasChildren?: boolean
  onIconChange: (icon: string | null) => void
  onToggleExpand?: () => void
  pickerOpen?: boolean
  onPickerOpenChange?: (open: boolean) => void
}

export function FolderIconButton({
  icon,
  isExpanded,
  hasChildren = false,
  onIconChange,
  onToggleExpand,
  pickerOpen,
  onPickerOpenChange
}: FolderIconButtonProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [portalPosition, setPortalPosition] = useState<{ top: number; left: number } | null>(null)

  const isControlled = pickerOpen !== undefined
  const isPickerOpen = isControlled ? pickerOpen : internalOpen

  const setPickerOpen = useCallback(
    (open: boolean) => {
      if (isControlled) {
        onPickerOpenChange?.(open)
      } else {
        setInternalOpen(open)
      }
    },
    [isControlled, onPickerOpenChange]
  )

  useEffect(() => {
    if (isControlled) {
      setInternalOpen(pickerOpen)
    }
  }, [isControlled, pickerOpen])

  useEffect(() => {
    if (isPickerOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect()
      setPortalPosition({ top: rect.bottom + 4, left: rect.left })
    }
  }, [isPickerOpen])

  const handleIconClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      e.preventDefault()
      setPickerOpen(!isPickerOpen)
    },
    [setPickerOpen, isPickerOpen]
  )

  const handleExpandClick = useCallback((_e: React.MouseEvent) => {
    // Let the click bubble to TreeNodeTrigger which handles expand/collapse
  }, [])

  const handleSelect = useCallback(
    (value: string) => {
      onIconChange(value)
      setPickerOpen(false)
    },
    [onIconChange, setPickerOpen]
  )

  const handleRemove = useCallback(() => {
    onIconChange(null)
    setPickerOpen(false)
  }, [onIconChange, setPickerOpen])

  const handleClose = useCallback(() => {
    setPickerOpen(false)
  }, [setPickerOpen])

  const folderIcon = icon ? (
    <NoteIconDisplay value={icon} className="text-sm leading-none" />
  ) : isExpanded ? (
    <FolderOpen className="h-4 w-4 text-muted-foreground" />
  ) : (
    <Folder className="h-4 w-4 text-muted-foreground" />
  )

  return (
    <div className="shrink-0 flex items-center gap-0.5">
      {hasChildren ? (
        <button
          type="button"
          onClick={handleExpandClick}
          className="flex h-4 w-4 items-center justify-center cursor-pointer rounded"
          aria-label={isExpanded ? 'Collapse folder' : 'Expand folder'}
        >
          <ArrowRight
            className={cn(
              'h-3 w-3 text-muted-foreground/60 transition-transform ',
              isExpanded && 'rotate-90'
            )}
          />
        </button>
      ) : (
        <div className="h-4 w-4" />
      )}

      <button
        ref={buttonRef}
        type="button"
        onClick={handleIconClick}
        className="flex h-5 w-5 items-center justify-center rounded"
        aria-label="Set folder icon"
      >
        {folderIcon}
      </button>

      {isPickerOpen &&
        portalPosition &&
        createPortal(
          <div
            className="fixed z-[100]"
            style={{ top: portalPosition.top, left: portalPosition.left }}
          >
            <EmojiPicker
              isOpen
              onClose={handleClose}
              onSelect={handleSelect}
              onRemove={handleRemove}
              hasEmoji={!!icon}
            />
          </div>,
          document.body
        )}
    </div>
  )
}
