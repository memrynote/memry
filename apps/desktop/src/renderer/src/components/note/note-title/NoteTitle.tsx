import { lazy, Suspense, useCallback, useState, type RefObject } from 'react'
import { cn } from '@/lib/utils'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { TitleInput } from './TitleInput'
import { useT } from '@memry/i18n/renderer'

const LazyEmojiPicker = lazy(async () => ({
  default: (await import('./EmojiPicker')).EmojiPicker
}))

export interface NoteTitleProps {
  emoji: string | null
  title: string
  placeholder?: string
  onTitleChange: (title: string) => void
  autoFocus?: boolean
  disabled?: boolean
  /** Optional external ref to the title textarea (e.g. to focus from the menu) */
  inputRef?: RefObject<HTMLTextAreaElement | null>
  /**
   * Persist a new icon, or `null` to clear it. When given, the icon next to the
   * title becomes a button that opens the shared picker. Notes without an icon
   * show nothing — the note page never offers a default placeholder glyph.
   */
  onIconChange?: (icon: string | null) => void
}

export function NoteTitle({
  emoji,
  title,
  placeholder,
  onTitleChange,
  autoFocus = false,
  disabled = false,
  inputRef,
  onIconChange
}: NoteTitleProps) {
  const { t } = useT('notes')
  const [pickerOpen, setPickerOpen] = useState(false)

  const handleIconSelect = useCallback(
    (value: string) => {
      onIconChange?.(value)
      setPickerOpen(false)
    },
    [onIconChange]
  )

  const handleIconRemove = useCallback(() => {
    onIconChange?.(null)
    setPickerOpen(false)
  }, [onIconChange])

  // No resting fill: emoji and library icons render bare, and a custom image
  // fills the whole tile, clipped to its squircle.
  const iconBoxClass =
    'flex items-center justify-center shrink-0 size-14 rounded-xl overflow-hidden'
  const icon = emoji ? (
    <NoteIconDisplay
      value={emoji}
      className="text-[28px] leading-8"
      customIconClassName="size-14 object-cover"
    />
  ) : null

  return (
    <div className={cn('relative flex items-center gap-3')}>
      {emoji &&
        (onIconChange && !disabled ? (
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                data-testid="note-title-icon"
                aria-label={t('tree.actions.setIcon')}
                className={cn(
                  iconBoxClass,
                  'transition-[background-color,filter] hover:bg-sidebar-terracotta/8 hover:brightness-95'
                )}
              >
                {icon}
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              sideOffset={6}
              className="w-auto border-0 bg-transparent p-0 shadow-none"
            >
              <Suspense fallback={null}>
                <LazyEmojiPicker
                  isOpen
                  embedded
                  onClose={() => setPickerOpen(false)}
                  onSelect={handleIconSelect}
                  onRemove={handleIconRemove}
                  hasEmoji
                />
              </Suspense>
            </PopoverContent>
          </Popover>
        ) : (
          <div className={iconBoxClass}>{icon}</div>
        ))}

      <div className="min-w-0 flex-1">
        <TitleInput
          value={title}
          placeholder={placeholder ?? t('editor.title.untitled')}
          onChange={onTitleChange}
          autoFocus={autoFocus}
          disabled={disabled}
          inputRef={inputRef}
        />
      </div>
    </div>
  )
}
