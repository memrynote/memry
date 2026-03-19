import { useRef, useCallback } from 'react'
import Picker from '@emoji-mart/react'
import data from '@emoji-mart/data'
import { cn } from '@/lib/utils'
import { useClickOutside } from './use-click-outside'
import { X } from '@/lib/icons'

interface EmojiPickerProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (emoji: string) => void
  onRemove: () => void
  hasEmoji: boolean
}

interface EmojiData {
  native: string
  id: string
  name: string
  unified: string
  keywords: string[]
  shortcodes: string
}

export function EmojiPicker({ isOpen, onClose, onSelect, onRemove, hasEmoji }: EmojiPickerProps) {
  const pickerRef = useRef<HTMLDivElement>(null)

  useClickOutside(pickerRef, onClose, isOpen)

  const handleEmojiSelect = useCallback(
    (emoji: EmojiData) => {
      onSelect(emoji.native)
      onClose()
    },
    [onSelect, onClose]
  )

  const handleRemove = useCallback(() => {
    onRemove()
    onClose()
  }, [onRemove, onClose])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    },
    [onClose]
  )

  if (!isOpen) return null

  return (
    <div
      ref={pickerRef}
      role="dialog"
      aria-modal="true"
      aria-label="Emoji picker"
      onKeyDown={handleKeyDown}
      className={cn(
        'absolute left-0 top-full z-50 mt-2',
        'rounded-xl border border-stone-200 bg-white shadow-lg',
        'animate-in fade-in-0 zoom-in-95 duration-150'
      )}
    >
      <Picker
        data={data}
        onEmojiSelect={handleEmojiSelect}
        theme="light"
        previewPosition="none"
        skinTonePosition="none"
        maxFrequentRows={2}
        perLine={8}
        navPosition="bottom"
        searchPosition="sticky"
        emojiSize={28}
        emojiButtonSize={36}
        categories={[
          'frequent',
          'people',
          'nature',
          'foods',
          'activity',
          'places',
          'objects',
          'symbols',
          'flags'
        ]}
      />

      {hasEmoji && (
        <div className="border-t border-stone-200 p-2">
          <button
            type="button"
            onClick={handleRemove}
            className={cn(
              'flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2',
              'text-sm text-stone-600',
              'transition-colors duration-150',
              'hover:bg-stone-100 hover:text-stone-900'
            )}
          >
            <X className="h-4 w-4" />
            Remove emoji
          </button>
        </div>
      )}
    </div>
  )
}
