import { useEffect, useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useT } from '@memry/i18n/renderer'
import { isMac } from '@/lib/shortcut-registry'

export type EditorMenuAction =
  | 'cut'
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'undo'
  | 'redo'
  | 'comment'
  | 'addAlternative'
  | 'suggestAlternatives'
  | 'ghost'
  | 'revive'
  | 'stash'
  | 'addToDictionary'

export type EditorMenuEntry =
  | { kind: 'action'; action: EditorMenuAction; disabled: boolean; shortcut?: string }
  | { kind: 'spelling'; suggestion: string }
  | { kind: 'noSpelling' }
  | { kind: 'separator' }

export interface EditorMenuContext {
  /** A non-empty text selection is live */
  hasSelection: boolean
  canUndo: boolean
  canRedo: boolean
  /** The selection is plain text the overflow list can hold (no pills, images, embeds) */
  canStash: boolean
  /** The selection (or the click) can carry an alternative */
  canAddAlternative: boolean
  /** Undefined: this editor has no comment action. Otherwise whether it applies here. */
  canComment?: boolean
  aiEnabled: boolean
  /** The click landed inside a ghosted range */
  insideGhost: boolean
  spelling: { misspelledWord: string; dictionarySuggestions: string[] } | null
}

const MOD = isMac ? '⌘' : 'Ctrl+'
const ADD_ALTERNATIVE_SHORTCUT = isMac ? '⌥⌘A' : 'Ctrl+Alt+A'
const REDO_SHORTCUT = isMac ? '⇧⌘Z' : 'Ctrl+Y'

/** What the editor's right-click menu offers, in order, for one click. */
export function editorContextMenuEntries(context: EditorMenuContext): EditorMenuEntry[] {
  const entries: EditorMenuEntry[] = []

  if (context.spelling?.misspelledWord) {
    const suggestions = context.spelling.dictionarySuggestions
    if (suggestions.length === 0) entries.push({ kind: 'noSpelling' })
    for (const suggestion of suggestions) entries.push({ kind: 'spelling', suggestion })
    entries.push(
      { kind: 'action', action: 'addToDictionary', disabled: false },
      { kind: 'separator' }
    )
  }

  entries.push(
    { kind: 'action', action: 'cut', disabled: !context.hasSelection, shortcut: `${MOD}X` },
    { kind: 'action', action: 'copy', disabled: !context.hasSelection, shortcut: `${MOD}C` },
    { kind: 'action', action: 'paste', disabled: false, shortcut: `${MOD}V` },
    { kind: 'action', action: 'selectAll', disabled: false, shortcut: `${MOD}A` },
    { kind: 'separator' },
    { kind: 'action', action: 'undo', disabled: !context.canUndo, shortcut: `${MOD}Z` },
    { kind: 'action', action: 'redo', disabled: !context.canRedo, shortcut: REDO_SHORTCUT },
    { kind: 'separator' }
  )

  if (context.canComment !== undefined) {
    entries.push({ kind: 'action', action: 'comment', disabled: !context.canComment })
  }
  entries.push({
    kind: 'action',
    action: 'addAlternative',
    disabled: !context.canAddAlternative,
    shortcut: ADD_ALTERNATIVE_SHORTCUT
  })
  if (context.aiEnabled) {
    entries.push({
      kind: 'action',
      action: 'suggestAlternatives',
      disabled: !context.canAddAlternative
    })
  }

  entries.push(
    { kind: 'separator' },
    context.insideGhost
      ? { kind: 'action', action: 'revive', disabled: false }
      : { kind: 'action', action: 'ghost', disabled: !context.hasSelection },
    { kind: 'action', action: 'stash', disabled: !context.canStash }
  )

  return entries
}

interface EditorContextMenuProps {
  x: number
  y: number
  entries: EditorMenuEntry[]
  onAction: (action: EditorMenuAction) => void
  onReplaceSpelling: (suggestion: string) => void
  onClose: () => void
}

/**
 * The note editor's right-click menu: a controlled dropdown anchored at the
 * click point, like the image attachment menu. Keyboard navigation, typeahead
 * and Escape come from the Radix menu.
 */
export function EditorContextMenu({
  x,
  y,
  entries,
  onAction,
  onReplaceSpelling,
  onClose
}: EditorContextMenuProps) {
  const { t } = useT('notes')
  const labels: Record<EditorMenuAction, string> = {
    cut: t('writingTools.menu.cut'),
    copy: t('writingTools.menu.copy'),
    paste: t('writingTools.menu.paste'),
    selectAll: t('writingTools.menu.selectAll'),
    undo: t('writingTools.menu.undo'),
    redo: t('writingTools.menu.redo'),
    comment: t('writingTools.menu.comment'),
    addAlternative: t('writingTools.menu.addAlternative'),
    suggestAlternatives: t('writingTools.menu.suggestAlternatives'),
    ghost: t('writingTools.menu.ghost'),
    revive: t('writingTools.menu.revive'),
    stash: t('writingTools.menu.stash'),
    addToDictionary: t('writingTools.menu.addToDictionary')
  }
  // Opened a microtask after mount so Radix sees a closed -> open change and
  // moves focus into the menu (same as ImageAttachmentMenu).
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) setOpen(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden="true"
          style={{ position: 'fixed', top: y, left: x, width: 0, height: 0 }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        aria-label={t('writingTools.menu.aria')}
        data-testid="editor-context-menu"
        className="min-w-52"
        // Focus goes back to the editor, not to the invisible anchor.
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {entries.map((entry, index) => {
          switch (entry.kind) {
            case 'separator':
              return <DropdownMenuSeparator key={`separator-${index}`} />
            case 'noSpelling':
              return (
                <DropdownMenuItem key="no-spelling" disabled>
                  {t('writingTools.menu.noSpellingSuggestions')}
                </DropdownMenuItem>
              )
            case 'spelling':
              return (
                <DropdownMenuItem
                  key={`spelling-${entry.suggestion}`}
                  className="font-medium"
                  onSelect={() => onReplaceSpelling(entry.suggestion)}
                >
                  {entry.suggestion}
                </DropdownMenuItem>
              )
            case 'action':
              return (
                <DropdownMenuItem
                  key={entry.action}
                  disabled={entry.disabled}
                  data-action={entry.action}
                  onSelect={() => onAction(entry.action)}
                >
                  {labels[entry.action]}
                  {entry.shortcut && (
                    <DropdownMenuShortcut className="tracking-normal tabular-nums">
                      {entry.shortcut}
                    </DropdownMenuShortcut>
                  )}
                </DropdownMenuItem>
              )
          }
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The occurrence of `word` in `text` that `offset` falls in or touches, as
 * [start, end) offsets. Spelling suggestions name the misspelled word but not
 * where it is; the click position decides between repeats.
 */
export function findWordAt(
  text: string,
  offset: number,
  word: string
): { start: number; end: number } | null {
  if (!word) return null
  let nearest: { start: number; end: number; distance: number } | null = null
  let searchFrom = 0
  while (searchFrom <= text.length) {
    const start = text.indexOf(word, searchFrom)
    if (start === -1) break
    const end = start + word.length
    const distance = offset < start ? start - offset : offset > end ? offset - end : 0
    if (!nearest || distance < nearest.distance) nearest = { start, end, distance }
    searchFrom = start + 1
  }
  return nearest ? { start: nearest.start, end: nearest.end } : null
}
