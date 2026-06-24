import { lazy, Suspense, useCallback, useState } from 'react'
import { Tag } from '@/lib/icons'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { useT } from '@memry/i18n/renderer'

const LazyEmojiPicker = lazy(async () => ({
  default: (await import('@/components/note/note-title/EmojiPicker')).EmojiPicker
}))

interface TagIconChipProps {
  /** Current tag icon (raw emoji "📚" or "icon:Name"), or null for the default glyph */
  icon: string | null
  /** Tag color (hex), tints the default tag glyph when no icon is set */
  color?: string
  /** Persist a new icon, or null to clear back to the default */
  onIconChange: (icon: string | null) => void
}

/**
 * Tag Config row chip showing a tag's custom icon (or a color-tinted tag glyph).
 * Clicking opens the shared emoji/icon picker to set, change, or remove it.
 *
 * Hosted in a Radix Popover (modal) so the picker is clickable even when the
 * chip lives inside the settings modal Dialog — a plain `document.body` portal
 * inherits the Dialog's `pointer-events: none` and would be visible but inert.
 */
export function TagIconChip({ icon, color, onIconChange }: TagIconChipProps): React.JSX.Element {
  const { t } = useT('settings')
  const [open, setOpen] = useState(false)

  const handleSelect = useCallback(
    (value: string) => {
      onIconChange(value)
      setOpen(false)
    },
    [onIconChange]
  )

  const handleRemove = useCallback(() => {
    onIconChange(null)
    setOpen(false)
  }, [onIconChange])

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          aria-label={t('tags.actions.changeIcon')}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent"
        >
          {icon ? (
            <NoteIconDisplay value={icon} className="size-[15px] text-[15px] leading-none" />
          ) : (
            <Tag className="h-3.5 w-3.5" style={{ color: color ?? undefined }} />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-auto border-0 bg-transparent p-0 shadow-none"
        onClick={(e) => e.stopPropagation()}
      >
        <Suspense fallback={null}>
          <LazyEmojiPicker
            isOpen
            embedded
            onClose={() => setOpen(false)}
            onSelect={handleSelect}
            onRemove={handleRemove}
            hasEmoji={!!icon}
          />
        </Suspense>
      </PopoverContent>
    </Popover>
  )
}
