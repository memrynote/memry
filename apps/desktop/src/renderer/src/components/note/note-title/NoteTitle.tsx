import { useState, useCallback } from 'react'
import { cn } from '@/lib/utils'
import { EmojiButton } from './EmojiButton'
import { EmojiPicker } from './EmojiPicker'
import { TitleInput } from './TitleInput'

export interface NoteTitleProps {
  emoji: string | null
  title: string
  placeholder?: string
  onEmojiChange: (emoji: string | null) => void
  onTitleChange: (title: string) => void
  autoFocus?: boolean
  disabled?: boolean
}

export function NoteTitle({
  emoji,
  title,
  placeholder = 'Untitled',
  onEmojiChange,
  onTitleChange,
  autoFocus = false,
  disabled = false
}: NoteTitleProps) {
  const [isPickerOpen, setIsPickerOpen] = useState(false)

  const handleEmojiButtonClick = useCallback(() => {
    if (!disabled) {
      setIsPickerOpen((prev) => !prev)
    }
  }, [disabled])

  const handleClosePicker = useCallback(() => {
    setIsPickerOpen(false)
  }, [])

  const handleEmojiSelect = useCallback(
    (selectedEmoji: string) => {
      onEmojiChange(selectedEmoji)
    },
    [onEmojiChange]
  )

  const handleEmojiRemove = useCallback(() => {
    onEmojiChange(null)
  }, [onEmojiChange])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Open picker with Enter on emoji button
      if (e.key === 'Enter' && e.target instanceof HTMLButtonElement && !isPickerOpen) {
        e.preventDefault()
        setIsPickerOpen(true)
      }
    },
    [isPickerOpen]
  )

  return (
    <div className={cn('relative mb-4 flex items-start gap-3')}>
      {/* Emoji Section */}
      <div className="relative" onKeyDown={handleKeyDown}>
        <EmojiButton emoji={emoji} onClick={handleEmojiButtonClick} disabled={disabled} />
        <EmojiPicker
          isOpen={isPickerOpen}
          onClose={handleClosePicker}
          onSelect={handleEmojiSelect}
          onRemove={handleEmojiRemove}
          hasEmoji={emoji !== null}
        />
      </div>

      {/* Title Section */}
      <div className="min-w-0 flex-1 pt-1">
        <TitleInput
          value={title}
          placeholder={placeholder}
          onChange={onTitleChange}
          autoFocus={autoFocus}
          disabled={disabled}
        />
      </div>
    </div>
  )
}
