import { useRef, useCallback, useState, useLayoutEffect } from 'react'
import Picker from '@emoji-mart/react'
import data from '@emoji-mart/data'
import { useTheme } from 'next-themes'
import { cn } from '@/lib/utils'
import { useClickOutside } from './use-click-outside'
import { X } from '@/lib/icons'
import { HugeIconGrid } from './HugeIconGrid'
import { CustomIconGrid } from './CustomIconGrid'
import { toCustomIconValue, toIconValue } from './emoji-icon-utils'
import { useT } from '@memry/i18n/renderer'

type PickerTab = 'emoji' | 'icons' | 'custom'

interface EmojiPickerProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (emoji: string) => void
  onRemove: () => void
  hasEmoji: boolean
  /**
   * When hosted inside a layer that already provides anchoring + dismissal
   * (e.g. a Radix Popover in the tag icon chip), render as a static panel
   * instead of an absolutely-positioned floating one, and let the host own
   * outside-click. Needed so the picker is clickable inside a modal Dialog.
   */
  embedded?: boolean
}

interface EmojiData {
  native: string
  id: string
  name: string
  unified: string
  keywords: string[]
  shortcodes: string
}

export function EmojiPicker({
  isOpen,
  onClose,
  onSelect,
  onRemove,
  hasEmoji,
  embedded = false
}: EmojiPickerProps) {
  const { t } = useT('notes')
  const { t: tCommon } = useT('common')
  const pickerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [activeTab, setActiveTab] = useState<PickerTab>('emoji')
  const [contentSize, setContentSize] = useState<{ width: number; height: number } | null>(null)
  const { resolvedTheme } = useTheme()

  useLayoutEffect(() => {
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

  // When embedded, the host (Popover) owns dismissal — avoid a double handler.
  useClickOutside(pickerRef, onClose, isOpen && !embedded)

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

  const handleCustomIconSelect = useCallback(
    (iconId: string) => {
      onSelect(toCustomIconValue(iconId))
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
      aria-label={t('menus.emoji.aria')}
      onKeyDown={handleKeyDown}
      className={cn(
        embedded ? 'relative' : 'absolute start-0 top-full z-50 mt-2',
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
          {t('menus.emoji.emojiTab')}
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
          {t('menus.emoji.iconsTab')}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('custom')}
          className={cn(
            'flex-1 px-4 py-2 text-sm font-medium transition-colors',
            activeTab === 'custom'
              ? 'text-foreground border-b-2 border-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {t('menus.emoji.customTab')}
        </button>
      </div>

      <div
        ref={contentRef}
        style={
          activeTab !== 'emoji' && contentSize
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
        ) : activeTab === 'icons' ? (
          <HugeIconGrid onSelect={handleIconSelect} />
        ) : (
          <CustomIconGrid onSelect={handleCustomIconSelect} />
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
            {tCommon('button.remove')}
          </button>
        </div>
      )}
    </div>
  )
}
