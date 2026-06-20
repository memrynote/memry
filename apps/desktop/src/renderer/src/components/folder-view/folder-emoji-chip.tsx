import { lazy, Suspense, useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { Folder } from '@/lib/icons'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { useT } from '@memry/i18n/renderer'

const LazyEmojiPicker = lazy(async () => ({
  default: (await import('@/components/note/note-title/EmojiPicker')).EmojiPicker
}))

interface FolderEmojiChipProps {
  /** Current folder icon (raw emoji "📚" or "icon:StarIcon"), or null for default */
  icon: string | null
  /** Persist a new icon, or null to clear back to the default folder glyph */
  onIconChange: (icon: string | null) => void
}

/**
 * Folder-view header chip showing the folder's custom emoji (or a default folder
 * glyph). Clicking opens the shared emoji picker to set/change/remove the icon.
 */
export function FolderEmojiChip({ icon, onIconChange }: FolderEmojiChipProps): React.JSX.Element {
  const { t } = useT('common')
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
        aria-label={t('phaseF.componentsFolderIconButton.setFolderIcon')}
        className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[9px] border bg-muted transition-colors hover:bg-accent"
      >
        {icon ? (
          <NoteIconDisplay value={icon} className="text-[17px] leading-none" />
        ) : (
          <Folder className="h-4 w-4 text-muted-foreground" />
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
