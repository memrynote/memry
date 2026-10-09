/* eslint-disable @typescript-eslint/no-explicit-any -- the BlockNote editor instance is untyped across content-area hooks */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import type { TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'
import { notesService } from '@/services/notes-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createWikiLinkInlineContent } from '@/components/note/content-area/wiki-link'
import { FileText } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { addPresetTag, createObject, lastCreateTag } from './create-object'
import { buildCreateOptions, type CreateOption } from './mention-create-options'
import { lookOfTag } from './object-look'
import { tagDisplayName } from './tag-display-name'
import { ObjectAvatar, type ObjectLook } from './object-avatar'
import { QuickFieldsCard, quickFields, type QuickFieldsTarget } from './quick-fields-card'
import { tagSchemaQueryKey, useEditTagSchema, useTagSchemas } from './use-tag-schemas'

interface CreateMenuState {
  title: string
  position: { x: number; y: number }
  options: CreateOption[]
  selectedIndex: number
}

const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'])

export function useMentionCreate(editor: any, containerRef: RefObject<HTMLDivElement | null>) {
  const { t } = useT('notes')
  const queryClient = useQueryClient()
  const { data: snapshot } = useTagSchemas()
  const edit = useEditTagSchema()
  const [menu, setMenu] = useState<CreateMenuState | null>(null)
  const menuRef = useRef<CreateMenuState | null>(null)
  const [quick, setQuick] = useState<QuickFieldsTarget | null>(null)

  const setMenuState = useCallback((next: CreateMenuState | null) => {
    menuRef.current = next
    setMenu(next)
  }, [])

  const openCreate = useCallback(
    (title: string, position: { x: number; y: number }) => {
      setMenuState({
        title,
        position,
        options: buildCreateOptions(snapshot, lastCreateTag.get()),
        selectedIndex: 0
      })
    },
    [snapshot, setMenuState]
  )

  const commit = useCallback(
    async (option: CreateOption | null) => {
      const state = menuRef.current
      setMenuState(null)
      if (!state || !option) return
      const insertLink = (title: string): void =>
        editor.insertInlineContent([createWikiLinkInlineContent(title, ''), ' '], {
          updateSelection: true
        })
      try {
        if (option.kind === 'plain') {
          const result = await notesService.create({ title: state.title, content: '' })
          if (!result.success || !result.note) throw new Error(result.error)
          insertLink(result.note.title)
          return
        }
        const tag = option.kind === 'preset' ? await addPresetTag(edit, option.preset) : option.tag
        lastCreateTag.set(tag)
        const created = await createObject({ title: state.title, tag })
        insertLink(created.title)
        const latest = queryClient.getQueryData<TagSchemaSnapshot>(tagSchemaQueryKey)
        const resolved = latest?.tags[tag] ?? snapshot?.tags[tag]
        const fields = resolved ? quickFields(resolved.effectiveFields) : []
        if (resolved && fields.length > 0) {
          setQuick({
            noteId: created.id,
            title: created.title,
            tag,
            tagName: resolved.name,
            look: lookOfTag(resolved),
            fields,
            position: state.position
          })
        }
      } catch (error) {
        toast.error(extractErrorMessage(error, t('tagObjects.create.failed')))
      }
    },
    [editor, edit, queryClient, snapshot, setMenuState, t]
  )

  const closeQuick = useCallback(() => {
    setQuick(null)
    editor?.focus?.()
  }, [editor])

  const isOpen = menu !== null
  useEffect(() => {
    const container = containerRef.current
    if (!isOpen || !container) return
    const onKeyDown = (event: KeyboardEvent): void => {
      const state = menuRef.current
      if (!state || MODIFIERS.has(event.key)) return
      const handled = ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)
      if (handled) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const count = state.options.length
        const step = event.key === 'ArrowDown' ? 1 : -1
        setMenuState({ ...state, selectedIndex: (state.selectedIndex + step + count) % count })
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        void commit(state.options[state.selectedIndex] ?? null)
      } else {
        editor.insertInlineContent(state.title)
        setMenuState(null)
      }
    }
    const onMouseDown = (event: MouseEvent): void => {
      if ((event.target as HTMLElement | null)?.closest('[data-mention-create-menu]')) return
      const state = menuRef.current
      if (state) editor.insertInlineContent(state.title)
      setMenuState(null)
    }
    container.addEventListener('keydown', onKeyDown, { capture: true })
    document.addEventListener('mousedown', onMouseDown, { capture: true })
    return () => {
      container.removeEventListener('keydown', onKeyDown, { capture: true })
      document.removeEventListener('mousedown', onMouseDown, { capture: true })
    }
  }, [isOpen, containerRef, commit, editor, setMenuState])

  const lookOf = (option: CreateOption): ObjectLook | null => {
    if (option.kind === 'preset') {
      return { tag: option.name, color: option.color, icon: option.icon, avatar: false }
    }
    return option.kind === 'tag' && snapshot?.tags[option.tag]
      ? lookOfTag(snapshot.tags[option.tag])
      : null
  }

  const overlay = (
    <>
      {menu && (
        <MentionCreateMenu
          state={menu}
          lookOf={lookOf}
          onSelect={(index) => void commit(menu.options[index] ?? null)}
        />
      )}
      {quick && <QuickFieldsCard target={quick} onClose={closeQuick} />}
    </>
  )

  return { openCreate, overlay }
}

function MentionCreateMenu({
  state,
  lookOf,
  onSelect
}: {
  state: CreateMenuState
  lookOf: (option: CreateOption) => ObjectLook | null
  onSelect: (index: number) => void
}): React.JSX.Element {
  const { t } = useT('notes')
  return (
    <div
      data-mention-create-menu
      data-inline-choice-menu
      role="listbox"
      aria-label={t('tagObjects.create.as', { title: state.title })}
      className="absolute z-50 w-[300px] rounded-lg border border-border bg-popover p-1 text-[13px] shadow-[var(--shadow-card-hover)] motion-safe:animate-in motion-safe:fade-in-0"
      style={{ left: state.position.x, top: state.position.y }}
    >
      <p className="px-2 py-1.5 text-xs text-muted-foreground">
        {t('tagObjects.create.asPrefix')}{' '}
        <span className="font-semibold text-foreground">{state.title}</span>{' '}
        {t('tagObjects.create.asSuffix')}
      </p>
      {state.options.map((option, index) => {
        const selected = index === state.selectedIndex
        const look = lookOf(option)
        const label =
          option.kind === 'plain' ? t('tagObjects.create.plainNote') : tagDisplayName(option.name)
        return (
          <div key={option.kind === 'tag' ? option.tag : option.kind + label}>
            {option.kind === 'plain' && state.options.length > 1 && (
              <div className="my-1 h-px bg-border" />
            )}
            <button
              type="button"
              role="option"
              aria-selected={selected}
              onMouseDown={(event) => {
                event.preventDefault()
                onSelect(index)
              }}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-[5px] px-2 py-1.5 text-start',
                selected ? 'bg-accent' : 'hover:bg-accent/60'
              )}
            >
              {look ? (
                <ObjectAvatar look={{ ...look, avatar: false }} title={label} size={24} />
              ) : (
                <span className="inline-flex size-6 items-center justify-center rounded-lg bg-muted">
                  <FileText className="size-3.5 text-muted-foreground" />
                </span>
              )}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-foreground">{label}</span>
                {option.kind === 'tag' && option.lastUsed && (
                  <span className="text-xs text-muted-foreground">
                    {t('tagObjects.create.lastUsed')}
                  </span>
                )}
                {option.kind === 'preset' && (
                  <span className="text-xs text-muted-foreground">
                    {t('tagObjects.create.readyMade')}
                  </span>
                )}
              </span>
              {selected && (
                <kbd className="rounded border border-border px-1 text-[11px] text-muted-foreground">
                  {t('tagObjects.keys.enter')}
                </kbd>
              )}
            </button>
          </div>
        )
      })}
    </div>
  )
}
