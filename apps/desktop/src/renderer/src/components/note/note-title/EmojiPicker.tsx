import { useRef, useCallback, useState, useEffect } from 'react'
import Picker from '@emoji-mart/react'
import data from '@emoji-mart/data'
import { useTheme } from 'next-themes'
import { cn } from '@/lib/utils'
import { useClickOutside } from './use-click-outside'
import { X } from '@/lib/icons'
import { HugeIconGrid } from './HugeIconGrid'
import { toIconValue } from './emoji-icon-utils'

type PickerTab = 'emoji' | 'icons'

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
  const contentRef = useRef<HTMLDivElement>(null)
  const [activeTab, setActiveTab] = useState<PickerTab>('emoji')
  const [contentSize, setContentSize] = useState<{ width: number; height: number } | null>(null)
  const { resolvedTheme } = useTheme()

  useEffect(() => {
    const el = contentRef.current
    if (!el || !isOpen) return

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry || activeTab !== 'emoji') return
      const { width, height } = entry.contentRect
      if (width > 0 && height > 0) {
        setContentSize({ width, height })
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [isOpen, activeTab])

  useClickOutside(pickerRef, onClose, isOpen)

  const handleEmojiSelect = useCallback(
    (emoji: EmojiData) => {
      onSelect(emoji.native)
      onClose()
    },
    [onSelect, onClose]
  )

  const handleIconSelect = useCallback(
    (iconName: string) => {
      onSelect(toIconValue(iconName))
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
      aria-label="Emoji and icon picker"
      onKeyDown={handleKeyDown}
      className={cn(
        'absolute left-0 top-full z-50 mt-2',
        'rounded-xl border border-border bg-popover shadow-lg',
        'animate-in fade-in-0 zoom-in-95 duration-150'
      )}
    >
      <div className="flex border-b border-border">
        <button
          type="button"
          onClick={() => setActiveTab('emoji')}
          className={cn(
            'flex-1 px-4 py-2 text-sm font-medium transition-colors',
            activeTab === 'emoji'
              ? 'text-foreground border-b-2 border-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          Emoji
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('icons')}
          className={cn(
            'flex-1 px-4 py-2 text-sm font-medium transition-colors',
            activeTab === 'icons'
              ? 'text-foreground border-b-2 border-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          Icons
        </button>
      </div>

      <div
        ref={contentRef}
        style={
          activeTab === 'icons' && contentSize
            ? { width: contentSize.width, height: contentSize.height, overflow: 'hidden' }
            : undefined
        }
      >
        {activeTab === 'emoji' ? (
          <Picker
            data={data}
            onEmojiSelect={handleEmojiSelect}
            theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
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
        ) : (
          <HugeIconGrid onSelect={handleIconSelect} />
        )}
      </div>

      {hasEmoji && (
        <div className="border-t border-border p-2">
          <button
            type="button"
            onClick={handleRemove}
            className={cn(
              'flex w-full items-center justify-center gap-2 rounded-md px-3 py-2',
              'text-sm text-muted-foreground',
              'transition-colors duration-150',
              'hover:bg-muted hover:text-foreground'
            )}
          >
            <X className="h-4 w-4" />
            Remove
          </button>
        </div>
      )}
    </div>
  )
}
