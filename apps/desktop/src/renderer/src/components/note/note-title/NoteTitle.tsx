import type { RefObject } from 'react'
import { cn } from '@/lib/utils'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { TitleInput } from './TitleInput'
import { useT } from '@memry/i18n/renderer'

export interface NoteTitleProps {
  emoji: string | null
  title: string
  placeholder?: string
  onTitleChange: (title: string) => void
  autoFocus?: boolean
  disabled?: boolean
  /** Optional external ref to the title textarea (e.g. to focus from the menu) */
  inputRef?: RefObject<HTMLTextAreaElement | null>
}

export function NoteTitle({
  emoji,
  title,
  placeholder,
  onTitleChange,
  autoFocus = false,
  disabled = false,
  inputRef
}: NoteTitleProps) {
  const { t } = useT('notes')

  return (
    <div className={cn('relative flex items-center gap-3')}>
      {emoji && (
        <div className="flex items-center justify-center shrink-0 size-14 rounded-xl bg-sidebar-terracotta/8">
          <NoteIconDisplay value={emoji} className="text-[28px] leading-8" />
        </div>
      )}

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
