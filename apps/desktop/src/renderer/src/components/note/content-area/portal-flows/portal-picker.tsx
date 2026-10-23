/**
 * The `((` picker: blocks, then notes, then "Create note". BlockNote owns
 * opening, the query, arrow keys, Enter and Esc (`SuggestionMenuController`);
 * this renders the rows and adds Cmd+Enter, which picks the create row.
 *
 * @module note/content-area/portal-flows/portal-picker
 */

import { useEffect, useEffectEvent, useRef, type ReactNode } from 'react'
import { useBlockNoteEditor, type SuggestionMenuProps } from '@blocknote/react'
import { useT } from '@memry/i18n/renderer'
import { FileText, Layers, Plus } from '@/lib/icons'
import { NoteMenuIcon } from '../note-menu-icon'
import { cn } from '@/lib/utils'
import type { PortalPickerItem } from './portal-picker-model'

// The `@` menu's row, so the two read as one control (mention-menu.tsx).
const ROW_CLASS =
  'mention-menu-item relative flex w-full cursor-pointer select-none items-center gap-2 rounded-[5px] px-2 py-1.5 text-start text-muted-foreground outline-none transition-colors hover:bg-accent focus:outline-none'

function SectionLabel({ children }: { children: ReactNode }): ReactNode {
  return (
    <div
      role="presentation"
      className="mention-menu-group px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground"
    >
      {children}
    </div>
  )
}

function Kbd({ children }: { children: ReactNode }): ReactNode {
  return <span className="font-mono text-[11px] leading-4 text-text-secondary">{children}</span>
}

/** `text` with the first case-insensitive match of `query` in bold. */
function Highlighted({ text, query }: { text: string; query: string }): ReactNode {
  const at = query === '' ? -1 : text.toLowerCase().indexOf(query.toLowerCase())
  if (at < 0) return text
  return (
    <>
      {text.slice(0, at)}
      <strong className="font-semibold text-foreground">{text.slice(at, at + query.length)}</strong>
      {text.slice(at + query.length)}
    </>
  )
}

const SECTION_OF: Record<PortalPickerItem['kind'], 'blocks' | 'notes' | 'create'> = {
  block: 'blocks',
  note: 'notes',
  create: 'create'
}

export function PortalPicker({
  items,
  loadingState,
  selectedIndex,
  onItemClick
}: SuggestionMenuProps<PortalPickerItem>): ReactNode {
  const { t } = useT('notes')
  const editor = useBlockNoteEditor()
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedIndex])

  // Capture on the editor element, ahead of BlockNote's Enter handling, which
  // would insert the highlighted row instead of creating a note.
  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.isComposing) return
    const create = items.find((item) => item.kind === 'create')
    if (!create) return
    event.preventDefault()
    event.stopPropagation()
    onItemClick?.(create)
  })
  useEffect(() => {
    const root = editor.domElement
    if (!root) return
    const listener = (event: KeyboardEvent): void => {
      handleKeyDown(event)
    }
    root.addEventListener('keydown', listener, true)
    return () => {
      root.removeEventListener('keydown', listener, true)
    }
  }, [editor])

  if (items.length === 0) {
    return (
      <div className="mention-menu memry-portal-picker min-w-[220px] max-w-[360px] rounded-md border bg-popover p-3 text-[13px] text-muted-foreground shadow-[var(--shadow-card-hover)]">
        <div className="flex items-center gap-2">
          <FileText className="size-3.5 opacity-70" aria-hidden />
          <span>
            {loadingState === 'loaded'
              ? t('portalFlows.picker.empty')
              : t('portalFlows.picker.loading')}
          </span>
        </div>
      </div>
    )
  }

  const rows: ReactNode[] = []
  let section: string | null = null
  items.forEach((item, index) => {
    const itemSection = SECTION_OF[item.kind]
    if (itemSection !== section) {
      section = itemSection
      if (itemSection === 'create') {
        rows.push(<div key="create-separator" role="separator" className="my-1 border-t" />)
      } else {
        rows.push(
          <SectionLabel key={`section-${itemSection}`}>
            {itemSection === 'notes'
              ? t('portalFlows.picker.notes')
              : t('portalFlows.picker.blocks')}
          </SectionLabel>
        )
      }
    }
    const isSelected = index === selectedIndex
    rows.push(
      <button
        type="button"
        key={item.key}
        id={`bn-suggestion-menu-item-${index}`}
        role="option"
        aria-selected={isSelected}
        tabIndex={-1}
        className={cn(ROW_CLASS, isSelected && 'bg-accent')}
        onMouseDown={(event) => {
          event.preventDefault()
        }}
        onClick={() => onItemClick?.(item)}
      >
        {item.kind === 'note' ? (
          <NoteMenuIcon icon={item.emoji} className="size-3.5" />
        ) : item.kind === 'create' ? (
          <Plus className="size-3.5 shrink-0" aria-hidden />
        ) : (
          <Layers className="size-3.5 shrink-0" aria-hidden />
        )}
        {item.kind === 'create' ? (
          <>
            <span className="min-w-0 flex-1 truncate">
              {t('portalFlows.picker.create', { query: item.title })}
            </span>
            <span className="flex shrink-0 items-center gap-0.5">
              <Kbd>⌘</Kbd>
              <Kbd>↵</Kbd>
            </span>
          </>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate">
              {item.kind === 'block' ? (
                <Highlighted text={item.title} query={item.query} />
              ) : (
                item.title
              )}
            </span>
            <span className="max-w-[40%] shrink-0 truncate text-xs text-text-tertiary">
              {item.kind === 'block'
                ? item.parentText
                  ? `${item.noteTitle} › ${item.parentText}`
                  : item.noteTitle
                : item.folder}
            </span>
          </>
        )}
      </button>
    )
  })

  return (
    <div
      className={cn(
        'mention-menu memry-portal-picker z-50 flex min-w-[220px] max-w-[360px] max-h-[360px] flex-col',
        'rounded-md border bg-popover text-popover-foreground text-[13px] leading-4',
        'shadow-[var(--shadow-card-hover)] animate-in fade-in-0 zoom-in-95'
      )}
    >
      <div
        ref={listRef}
        role="listbox"
        aria-label={t('portalFlows.picker.aria')}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto p-1 [font-synthesis:none]"
      >
        {rows}
      </div>
      <div className="flex shrink-0 items-center gap-4 border-t px-3 py-2">
        <span className="flex items-center gap-1.5">
          <Kbd>↵</Kbd>
          <span className="text-xs leading-4 text-text-secondary">
            {t('portalFlows.picker.hintInsert')}
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>{t('portalFlows.picker.keyEsc')}</Kbd>
          <span className="text-xs leading-4 text-text-secondary">
            {t('portalFlows.picker.hintClose')}
          </span>
        </span>
      </div>
    </div>
  )
}
