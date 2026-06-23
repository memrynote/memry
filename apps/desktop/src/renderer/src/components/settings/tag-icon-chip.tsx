import { lazy, Suspense, useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { Tag } from '@/lib/icons'
import { NoteIconDisplay } from '@/lib/render-note-icon'
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
 */
export function TagIconChip({ icon, color, onIconChange }: TagIconChipProps): React.JSX.Element {
  const { t } = useT('settings')
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  const handleClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    setPos({ top: rect.bottom + 6, left: rect.left })
    setOpen((v) => !v)
  }, [])

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
    <>
      <button
        type="button"
        onClick={handleClick}
        aria-label={t('tags.actions.changeIcon')}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent"
      >
        {icon ? (
          <NoteIconDisplay value={icon} className="text-[15px] leading-none" />
        ) : (
          <Tag className="h-3.5 w-3.5" style={{ color: color ?? undefined }} />
        )}
      </button>

      {open &&
        pos &&
        createPortal(
          <div className="fixed z-[100]" style={{ top: pos.top, left: pos.left }}>
            <Suspense fallback={null}>
              <LazyEmojiPicker
                isOpen
                onClose={() => setOpen(false)}
                onSelect={handleSelect}
                onRemove={handleRemove}
                hasEmoji={!!icon}
              />
            </Suspense>
          </div>,
          document.body
        )}
    </>
  )
}
