import { lazy, Suspense, useCallback, useState } from 'react'
import { createPortal } from 'react-dom'

const LazyEmojiPicker = lazy(async () => ({
  default: (await import('@/components/note/note-title/EmojiPicker')).EmojiPicker
}))

interface IconPickerButtonProps {
  /** Glyph shown inside the clickable button (default icon or custom emoji/icon). */
  children: React.ReactNode
  /** True when a custom icon is set — enables the picker's Remove action. */
  hasIcon: boolean
  /** Receives the picked icon value, or `null` when removed. */
  onIconChange: (icon: string | null) => void
  ariaLabel: string
  /** Optional element rendered before the icon button (e.g. a folder expand chevron). */
  leading?: React.ReactNode
  /** Controlled open state. Omit for self-managed open/close on click. */
  pickerOpen?: boolean
  onPickerOpenChange?: (open: boolean) => void
}

/**
 * A clickable icon glyph that opens the emoji/icon picker, anchored via a portal.
 * Shared by folder and note rows so their icons stay the same size and behaviour.
 */
export function IconPickerButton({
  children,
  hasIcon,
  onIconChange,
  ariaLabel,
  leading,
  pickerOpen,
  onPickerOpenChange
}: IconPickerButtonProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const [portalPosition, setPortalPosition] = useState<{ top: number; left: number } | null>(null)

  const isControlled = pickerOpen !== undefined
  const isPickerOpen = isControlled ? pickerOpen : uncontrolledOpen

  const setPickerOpen = useCallback(
    (open: boolean) => {
      if (isControlled) {
        onPickerOpenChange?.(open)
      } else {
        setUncontrolledOpen(open)
      }
    },
    [isControlled, onPickerOpenChange]
  )

  const updatePortalPosition = useCallback((button: HTMLButtonElement) => {
    const rect = button.getBoundingClientRect()
    setPortalPosition({ top: rect.bottom + 4, left: rect.left })
  }, [])

  const handleButtonRef = useCallback(
    (button: HTMLButtonElement | null) => {
      if (button) {
        updatePortalPosition(button)
      } else {
        setPortalPosition(null)
      }
    },
    [updatePortalPosition]
  )

  const handleIconClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation()
      e.preventDefault()
      updatePortalPosition(e.currentTarget)
      setPickerOpen(!isPickerOpen)
    },
    [updatePortalPosition, setPickerOpen, isPickerOpen]
  )

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

  return (
    <div className="shrink-0 flex items-center gap-0.5">
      {leading}

      <button
        ref={handleButtonRef}
        type="button"
        onClick={handleIconClick}
        className="flex h-5 w-5 items-center justify-center rounded"
        aria-label={ariaLabel}
      >
        {children}
      </button>

      {isPickerOpen &&
        portalPosition &&
        createPortal(
          <div
            className="fixed z-[100]"
            style={{ top: portalPosition.top, left: portalPosition.left }}
          >
            <Suspense fallback={null}>
              <LazyEmojiPicker
                isOpen
                onClose={handleClose}
                onSelect={handleSelect}
                onRemove={handleRemove}
                hasEmoji={hasIcon}
              />
            </Suspense>
          </div>,
          document.body
        )}
    </div>
  )
}
