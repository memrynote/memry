/**
 * The `/` menu. BlockNote still owns opening, filtering input, arrow keys and
 * Enter (through `SuggestionMenuController`); this renders the rows and adds
 * two keys BlockNote does not have: ⌘/Ctrl+Enter for a row's secondary action,
 * and Up/Down/Enter over the fallback rows when nothing matches.
 */

import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { SuggestionMenu } from '@blocknote/core/extensions'
import { useBlockNoteEditor, useExtensionState, type SuggestionMenuProps } from '@blocknote/react'
import { useT } from '@memry/i18n/renderer'
import {
  Bell,
  Calendar,
  CheckCircle,
  CheckSquare,
  ChevronRight,
  Code,
  Collapse,
  File,
  FilePdf,
  FileVideo,
  Grid,
  Hierarchy,
  Image,
  Info,
  LayoutTemplate,
  Link,
  List,
  ListOrdered,
  Minus,
  Music,
  PenTool,
  Quote,
  Sigma,
  Smile,
  Sparkles,
  Type,
  Video,
  type AppIcon
} from '@/lib/icons'
import { isMac } from '@/lib/shortcut-registry'
import { cn } from '@/lib/utils'
import { recordSlashMenuRecent, type SlashMenuItem } from './slash-menu-model'

export type SlashMenuFallbacks = {
  /** Hands the query to the `[[` note search. */
  linkToNote: (query: string) => void
  /** Opens the AI menu. `null` when AI is off or not ready. */
  askAI: (() => void) | null
}

export const SlashMenuFallbackContext = createContext<SlashMenuFallbacks | null>(null)

const ICONS: Readonly<Record<string, AppIcon>> = {
  paragraph: Type,
  bullet_list: List,
  numbered_list: ListOrdered,
  check_list: CheckSquare,
  toggle_list: ChevronRight,
  toggle_heading: Collapse,
  toggle_heading_2: Collapse,
  toggle_heading_3: Collapse,
  quote: Quote,
  callout: Info,
  code_block: Code,
  divider: Minus,
  link_to_note: Link,
  date: Calendar,
  remind: Bell,
  task: CheckCircle,
  table: Grid,
  math: Sigma,
  diagram: Hierarchy,
  whiteboard: PenTool,
  emoji: Smile,
  insert_template: LayoutTemplate,
  image: Image,
  pdf: FilePdf,
  media: FileVideo,
  video: Video,
  audio: Music,
  file: File,
  ai: Sparkles
}

const HEADING_GLYPHS: Readonly<Record<string, string>> = {
  heading: 'H1',
  heading_2: 'H2',
  heading_3: 'H3',
  heading_4: 'H4',
  heading_5: 'H5',
  heading_6: 'H6'
}

function RowIcon({ id }: { id: string }): ReactNode {
  const glyph = HEADING_GLYPHS[id]
  if (glyph) {
    return <span className="text-[11px] font-semibold leading-none">{glyph}</span>
  }
  const Icon = ICONS[id] ?? (id.startsWith('template:') ? LayoutTemplate : File)
  return <Icon className={cn('size-4', id === 'ai' && 'text-tint')} aria-hidden />
}

function Title({ item }: { item: SlashMenuItem }): ReactNode {
  const { match, title } = item
  if (!match) return title
  return (
    <>
      {title.slice(0, match.start)}
      <span className="font-semibold">{title.slice(match.start, match.end)}</span>
      {title.slice(match.end)}
    </>
  )
}

function Key({ children }: { children: ReactNode }): ReactNode {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-background px-1.5 font-mono text-[11px] leading-none text-text-secondary">
      {children}
    </kbd>
  )
}

const ROW_CLASS =
  'flex h-8 w-full shrink-0 cursor-pointer select-none items-center gap-2.5 rounded-[5px] px-2 text-start outline-none transition-colors duration-100 hover:bg-surface-active'

type Fallback = { key: string; label: string; target?: string; icon: AppIcon; run: () => void }

export function SlashMenu({
  items,
  loadingState,
  selectedIndex,
  onItemClick
}: SuggestionMenuProps<SlashMenuItem>): ReactNode {
  const { t } = useT('notes')
  const editor = useBlockNoteEditor()
  const fallbackActions = useContext(SlashMenuFallbackContext)
  const query = useExtensionState(SuggestionMenu, {
    selector: (state) => state?.query ?? ''
  })
  const listRef = useRef<HTMLDivElement>(null)
  const [fallbackIndex, setFallbackIndex] = useState(0)

  const trimmedQuery = query.trim()
  const showEmpty = items.length === 0 && loadingState === 'loaded' && trimmedQuery.length > 0

  const fallbacks: Fallback[] = []
  if (showEmpty && fallbackActions) {
    fallbacks.push({
      key: 'link',
      label: t('editor.slashMenu.fallback.linkTo'),
      target: trimmedQuery,
      icon: Link,
      run: () => fallbackActions.linkToNote(trimmedQuery)
    })
    if (fallbackActions.askAI) {
      fallbacks.push({
        key: 'ai',
        label: t('editor.slashMenu.fallback.askAI'),
        icon: Sparkles,
        run: fallbackActions.askAI
      })
    }
  }
  const activeFallback = Math.min(fallbackIndex, Math.max(0, fallbacks.length - 1))

  // A new query is a new list; the first fallback is the one Enter runs.
  useEffect(() => {
    setFallbackIndex(0)
  }, [query])

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedIndex, activeFallback])

  const closeAndClear = (): void => {
    const extension = editor.getExtension(SuggestionMenu)
    extension?.closeMenu()
    extension?.clearQuery()
  }

  const runFallback = (fallback: Fallback): void => {
    closeAndClear()
    fallback.run()
  }

  // Capture on `document` so this runs before BlockNote's own handler, which
  // listens in capture on the editor element and treats every Enter — with or
  // without ⌘ — as "run the selected row".
  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.isComposing) return
    const root = editor.domElement
    if (!root || !(event.target instanceof Node) || !root.contains(event.target)) return

    if (items.length > 0) {
      if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
      const item = selectedIndex === undefined ? undefined : items[selectedIndex]
      if (!item?.secondary) return
      event.preventDefault()
      event.stopPropagation()
      closeAndClear()
      recordSlashMenuRecent(item.id)
      item.secondary.onItemClick()
      return
    }

    if (fallbacks.length === 0) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setFallbackIndex((activeFallback + step + fallbacks.length) % fallbacks.length)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      runFallback(fallbacks[activeFallback])
    }
  })

  useEffect(() => {
    const listener = (event: KeyboardEvent): void => handleKeyDown(event)
    document.addEventListener('keydown', listener, true)
    return () => document.removeEventListener('keydown', listener, true)
  }, [])

  if (items.length === 0 && !showEmpty) return null

  const selected = selectedIndex === undefined ? undefined : items[selectedIndex]
  const secondaryKey = isMac ? '⌘↵' : 'Ctrl ↵'

  const rows: ReactNode[] = []
  let currentGroup: string | undefined
  items.forEach((item, index) => {
    if (item.group !== currentGroup) {
      currentGroup = item.group
      rows.push(
        <div
          key={`group-${index}`}
          role="presentation"
          className={cn(
            'flex items-end px-2 pb-0.5 text-[11px] font-medium leading-[14px] text-text-secondary',
            index === 0 ? 'h-[26px] pt-1.5' : 'h-[30px] pt-2.5'
          )}
        >
          {item.group}
        </div>
      )
    }
    const isSelected = index === selectedIndex
    rows.push(
      <button
        type="button"
        key={`${item.group}-${item.id}-${index}`}
        id={`bn-suggestion-menu-item-${index}`}
        role="option"
        aria-selected={isSelected}
        aria-label={item.title}
        tabIndex={-1}
        className={cn(ROW_CLASS, isSelected && 'bg-surface-active')}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onItemClick?.(item)}
      >
        <span
          className={cn(
            'flex size-5 shrink-0 items-center justify-center',
            isSelected ? 'text-foreground' : 'text-text-secondary'
          )}
        >
          <RowIcon id={item.id} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-4 text-foreground">
          <Title item={item} />
        </span>
        {item.matchedAlias ? (
          <span className="flex shrink-0 items-center gap-1 text-[11px] leading-[14px] text-text-secondary">
            {t('editor.slashMenu.matchesAlias')}
            <span className="font-mono text-foreground">{item.matchedAlias}</span>
          </span>
        ) : item.hint ? (
          <span className="shrink-0 font-mono text-[11px] leading-[14px] text-text-secondary">
            {item.hint}
          </span>
        ) : null}
      </button>
    )
  })

  return (
    <div
      id="bn-suggestion-menu"
      role="listbox"
      aria-label={t('editor.slashMenu.aria')}
      className="bn-suggestion-menu memry-slash-menu flex max-h-[inherit] w-[360px] flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-[var(--shadow-dropdown)]"
    >
      <div ref={listRef} className="flex max-h-[340px] min-h-0 flex-1 flex-col overflow-y-auto p-1">
        {showEmpty ? (
          <>
            <div className="flex h-[30px] items-end px-2 pb-0.5 text-xs text-text-secondary">
              {t('editor.slashMenu.noMatch', { query: trimmedQuery })}
            </div>
            {fallbacks.map((fallback, index) => {
              const Icon = fallback.icon
              const isSelected = index === activeFallback
              return (
                <button
                  type="button"
                  key={fallback.key}
                  role="option"
                  aria-selected={isSelected}
                  tabIndex={-1}
                  className={cn(ROW_CLASS, isSelected && 'bg-surface-active')}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => runFallback(fallback)}
                >
                  <span className="flex size-5 shrink-0 items-center justify-center text-text-secondary">
                    <Icon
                      className={cn('size-4', fallback.key === 'ai' && 'text-tint')}
                      aria-hidden
                    />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-4 text-foreground">
                    {fallback.label}
                    {fallback.target ? (
                      <span className="font-semibold"> “{fallback.target}”</span>
                    ) : null}
                  </span>
                </button>
              )
            })}
          </>
        ) : (
          rows
        )}
      </div>
      {(selected || fallbacks.length > 0) && (
        <div className="flex h-9 shrink-0 items-center gap-3 border-t border-border bg-surface pe-2 ps-3">
          <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
            {selected?.subtext ?? ''}
          </span>
          {selected?.secondary ? (
            <>
              <span className="flex shrink-0 items-center gap-1.5 text-xs text-text-secondary">
                {selected.secondary.label}
                <Key>{secondaryKey}</Key>
              </span>
              <span className="h-3.5 w-px shrink-0 bg-border" aria-hidden />
            </>
          ) : null}
          <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-foreground">
            {selected ? t('editor.slashMenu.actions.insert') : t('editor.slashMenu.actions.open')}
            <Key>↵</Key>
          </span>
        </div>
      )}
    </div>
  )
}
