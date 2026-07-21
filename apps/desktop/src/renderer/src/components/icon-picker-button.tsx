import { lazy, Suspense, useCallback, useState } from 'react'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'

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

      <Popover open={isPickerOpen} onOpenChange={setPickerOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            onClick={(e) => e.stopPropagation()}
            className="flex h-5 w-5 items-center justify-center rounded"
            aria-label={ariaLabel}
          >
            {children}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={4}
          className="w-auto border-0 bg-transparent p-0 shadow-none"
          onClick={(e) => e.stopPropagation()}
        >
          <Suspense fallback={null}>
            <LazyEmojiPicker
              isOpen
              embedded
              onClose={handleClose}
              onSelect={handleSelect}
              onRemove={handleRemove}
              hasEmoji={hasIcon}
            />
          </Suspense>
        </PopoverContent>
      </Popover>
    </div>
  )
}
