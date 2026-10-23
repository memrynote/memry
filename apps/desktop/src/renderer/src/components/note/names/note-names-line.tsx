import { Fragment, useEffect, useState, type KeyboardEvent } from 'react'
import { MAX_NOTE_ALIAS_LENGTH } from '@memry/shared/note-names'
import { useT } from '@memry/i18n/renderer'
import { Plus } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { onNoteNameInputRequest } from './note-name-input-request'
import { useNameConflict } from './use-name-conflict'
import { useNoteNames } from './use-note-names'

interface NoteNamesLineProps {
  noteId: string | null
  title: string
  aliases: readonly string[]
  disabled?: boolean
}

type Draft = { mode: 'add' } | { mode: 'edit'; name: string }

const NAME_BUTTON = cn(
  'rounded-sm text-text-secondary',
  'transition-colors duration-150 motion-reduce:transition-none',
  'hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
  'disabled:pointer-events-none'
)

export function NoteNamesLine({ noteId, title, aliases, disabled }: NoteNamesLineProps) {
  const { t } = useT('notes')
  const { names, add, remove, rename } = useNoteNames(noteId, title, aliases)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [text, setText] = useState('')
  const conflict = useNameConflict(draft ? noteId : null, text)

  useEffect(() => {
    if (!noteId || disabled) return
    return onNoteNameInputRequest(noteId, () => {
      setText('')
      setDraft({ mode: 'add' })
    })
  }, [noteId, disabled])

  function open(next: Draft, initial: string): void {
    setText(initial)
    setDraft(next)
  }

  function close(): void {
    setDraft(null)
    setText('')
  }

  function commit(): void {
    if (!draft) return
    const value = text.trim()
    if (draft.mode === 'add') {
      if (value) add(value)
    } else if (value) {
      rename(draft.name, value)
    } else {
      remove(draft.name)
    }
    close()
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      commit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
    } else if (event.key === 'Backspace' && text === '' && draft) {
      event.preventDefault()
      const last = draft.mode === 'edit' ? draft.name : names.at(-1)
      if (last) remove(last)
      close()
    }
  }

  if (names.length === 0 && !draft) return null

  const editing = draft?.mode === 'edit' ? draft.name : null

  return (
    <div className="flex flex-col gap-1" data-testid="note-names">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] leading-5">
        <span className="text-text-tertiary">{t('names.also')} </span>
        {names.map((name, index) => (
          <Fragment key={name}>
            {index > 0 && (
              <span aria-hidden className="text-text-tertiary">
                {' · '}
              </span>
            )}
            {editing === name ? (
              <NameInput
                value={text}
                label={t('names.editLabel', { name })}
                onChange={setText}
                onKeyDown={onKeyDown}
                onBlur={close}
              />
            ) : (
              <button
                type="button"
                className={NAME_BUTTON}
                disabled={disabled}
                aria-label={t('names.editLabel', { name })}
                onClick={() => {
                  open({ mode: 'edit', name }, name)
                }}
              >
                {name}
              </button>
            )}
          </Fragment>
        ))}
        {draft?.mode === 'add' ? (
          <>
            {names.length > 0 && (
              <span aria-hidden className="text-text-tertiary">
                {' · '}
              </span>
            )}
            <NameInput
              value={text}
              label={t('names.inputLabel')}
              placeholder={t('names.inputPlaceholder')}
              onChange={setText}
              onKeyDown={onKeyDown}
              onBlur={close}
            />
          </>
        ) : (
          !disabled && (
            <button
              type="button"
              className={cn(
                NAME_BUTTON,
                'flex size-5 items-center justify-center text-text-tertiary',
                'opacity-0 group-hover/metadata:opacity-100 focus-visible:opacity-100'
              )}
              aria-label={t('names.add')}
              title={t('names.add')}
              onClick={() => {
                open({ mode: 'add' }, '')
              }}
            >
              <Plus className="size-3.5" aria-hidden />
            </button>
          )
        )}
      </div>
      {draft && conflict && (
        <p role="status" className="text-xs leading-4 text-text-tertiary">
          {conflict.isOtherTitle
            ? t('names.conflictTitle', { name: conflict.name })
            : t('names.conflictName', { name: conflict.name, title: conflict.title })}{' '}
          {conflict.otherKeepsName
            ? t('names.conflictKeeps', { title: conflict.title })
            : t('names.conflictTakesOver', { title: conflict.title })}
        </p>
      )}
    </div>
  )
}

interface NameInputProps {
  value: string
  label: string
  placeholder?: string
  onChange: (value: string) => void
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
  onBlur: () => void
}

function NameInput({ value, label, placeholder, onChange, onKeyDown, onBlur }: NameInputProps) {
  return (
    <input
      ref={(input) => input?.focus()}
      value={value}
      aria-label={label}
      placeholder={placeholder}
      maxLength={MAX_NOTE_ALIAS_LENGTH}
      size={Math.max(value.length, placeholder?.length ?? 4, 4)}
      className="min-w-0 border-b border-border bg-transparent p-0 text-[13px] leading-5 text-foreground outline-none placeholder:text-text-tertiary focus:border-ring"
      onChange={(event) => {
        onChange(event.target.value)
      }}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    />
  )
}
