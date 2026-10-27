import { useEffect } from 'react'
import { useT } from '@memry/i18n/renderer'

import { commands, type ContextMenuItem } from '../../../generated/bindings'
import { spellingFor } from '../services/writing-tools-service'
import { wordAtCaret, wordAtPoint, type WordSpan } from './word-at-point'

type EditCommand = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'

const EDIT_ITEMS: ReadonlyArray<{ id: EditCommand; key: string }> = [
  { id: 'undo', key: 'edit.undo' },
  { id: 'redo', key: 'edit.redo' },
  { id: 'cut', key: 'edit.cut' },
  { id: 'copy', key: 'edit.copy' },
  { id: 'paste', key: 'edit.paste' },
  { id: 'selectAll', key: 'edit.selectAll' }
]

/** A plain input or textarea, not the note editor (which has its own menu in Step 11). */
function plainEditableField(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false
  if (target.closest('.ProseMirror, [data-memry-native-menu="off"]')) return false
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  )
}

/**
 * WebView2 and WKWebView already show a native edit menu over a text field; WebKitGTK shows
 * none. On Linux only, this builds Undo, Redo, Cut, Copy, Paste and Select All with the enabled
 * flags `document.queryCommandEnabled` reports.
 */
export function useNativeEditMenu(): void {
  const { t } = useT('menu')
  useEffect(() => {
    if (document.documentElement.getAttribute('data-platform') !== 'linux') return undefined
    const onContextMenu = (event: MouseEvent): void => {
      const target = event.target
      if (!plainEditableField(target)) return
      event.preventDefault()
      void showMenu(event, target, t)
    }
    document.addEventListener('contextmenu', onContextMenu)
    return () => document.removeEventListener('contextmenu', onContextMenu)
  }, [t])
}

type Translate = (key: string) => string

const separator = (id: string): ContextMenuItem => ({
  id,
  label: '',
  type: 'separator',
  accelerator: null,
  disabled: null
})

const SPELL_PREFIX = 'spell:'
const SPELL_ADD = 'spell-add'

/** The word under the click in a field or in editable page text, with what replaces it. */
function wordUnder(
  event: MouseEvent,
  target: HTMLElement
): { span: WordSpan; replace: (text: string) => void } | null {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const span = wordAtCaret(target)
    if (!span) return null
    return {
      span,
      replace: (text) => {
        target.setRangeText(text, span.start, span.end, 'end')
        // A controlled React field learns of a programmatic change from an input event.
        target.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }
  }
  const hit = wordAtPoint(event.clientX, event.clientY)
  if (!hit) return null
  return {
    span: hit,
    replace: (text) => {
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(hit.range)
      // oxlint-disable-next-line typescript/no-deprecated
      document.execCommand('insertText', false, text)
    }
  }
}

async function showMenu(event: MouseEvent, target: HTMLElement, t: Translate): Promise<void> {
  const under = wordUnder(event, target)
  const spelling = under ? await spellingFor(under.span.word) : null
  const spellItems: ContextMenuItem[] = []
  if (spelling) {
    const suggestions = spelling.dictionarySuggestions
    if (suggestions.length === 0) {
      spellItems.push({
        id: 'spell-none',
        label: t('edit.noSuggestions'),
        accelerator: null,
        type: 'normal',
        disabled: true
      })
    }
    suggestions.forEach((suggestion, index) => {
      spellItems.push({
        id: `${SPELL_PREFIX}${index}`,
        label: suggestion,
        accelerator: null,
        type: 'normal',
        disabled: null
      })
    })
    spellItems.push(
      {
        id: SPELL_ADD,
        label: t('edit.addToDictionary'),
        accelerator: null,
        type: 'normal',
        disabled: null
      },
      separator('sep-spell')
    )
  }
  const editItems = [
    ...EDIT_ITEMS.slice(0, 2),
    separator('sep-1'),
    ...EDIT_ITEMS.slice(2, 5),
    separator('sep-2'),
    EDIT_ITEMS[5]
  ].map((item) =>
    'key' in item
      ? {
          id: item.id,
          label: t(item.key),
          accelerator: null,
          type: 'normal' as const,
          // No replacement exists for driving the page's own edit commands.
          // oxlint-disable-next-line typescript/no-deprecated
          disabled: !document.queryCommandEnabled(item.id === 'selectAll' ? 'selectAll' : item.id)
        }
      : item
  )
  const chosen = await commands.shellShowContextMenu([...spellItems, ...editItems])
  if (!chosen) return
  if (chosen === SPELL_ADD && under) {
    void commands.spellAddWord(under.span.word)
  } else if (chosen.startsWith(SPELL_PREFIX) && under && spelling) {
    const suggestion = spelling.dictionarySuggestions[Number(chosen.slice(SPELL_PREFIX.length))]
    if (suggestion !== undefined) under.replace(suggestion)
  } else if (EDIT_ITEMS.some((item) => item.id === chosen)) {
    // oxlint-disable-next-line typescript/no-deprecated
    document.execCommand(chosen)
  }
}
