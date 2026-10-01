import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  EditorContextMenu,
  editorContextMenuEntries,
  findWordAt,
  type EditorMenuContext,
  type EditorMenuEntry
} from './editor-context-menu'

const BASE: EditorMenuContext = {
  hasSelection: true,
  canUndo: true,
  canRedo: false,
  canStash: true,
  canAddAlternative: true,
  canComment: true,
  aiEnabled: true,
  insideGhost: false,
  spelling: null
}

/** Entries as `action` / `action!` (disabled) / `---` / `spell:<word>` tokens. */
function tokens(entries: EditorMenuEntry[]): string[] {
  return entries.map((entry) => {
    switch (entry.kind) {
      case 'separator':
        return '---'
      case 'spelling':
        return `spell:${entry.suggestion}`
      case 'noSpelling':
        return 'spell:none'
      case 'action':
        return entry.disabled ? `${entry.action}!` : entry.action
    }
  })
}

describe('editorContextMenuEntries', () => {
  it('orders clipboard and history, comment and alternatives, then ghost and stash', () => {
    expect(tokens(editorContextMenuEntries(BASE))).toEqual([
      'cut',
      'copy',
      'paste',
      'selectAll',
      '---',
      'undo',
      'redo!',
      '---',
      'comment',
      'addAlternative',
      'suggestAlternatives',
      '---',
      'ghost',
      'stash'
    ])
  })

  it('keeps every item but disables the ones that need a selection', () => {
    expect(
      tokens(
        editorContextMenuEntries({
          ...BASE,
          hasSelection: false,
          canAddAlternative: false,
          canComment: false,
          canStash: false
        })
      )
    ).toEqual([
      'cut!',
      'copy!',
      'paste',
      'selectAll',
      '---',
      'undo',
      'redo!',
      '---',
      'comment!',
      'addAlternative!',
      'suggestAlternatives!',
      '---',
      'ghost!',
      'stash!'
    ])
  })

  it('disables Stash for a selection the plain-text overflow list cannot hold', () => {
    expect(tokens(editorContextMenuEntries({ ...BASE, canStash: false }))).toContain('stash!')
  })

  it('hides Suggest alternatives entirely while AI is off', () => {
    expect(tokens(editorContextMenuEntries({ ...BASE, aiEnabled: false }))).not.toContain(
      'suggestAlternatives'
    )
  })

  it('omits Comment when the editor has no comment action', () => {
    expect(tokens(editorContextMenuEntries({ ...BASE, canComment: undefined }))).not.toContain(
      'comment'
    )
  })

  it('offers Revive instead of Ghost inside a ghosted range, even without a selection', () => {
    const entries = tokens(
      editorContextMenuEntries({ ...BASE, hasSelection: false, insideGhost: true })
    )
    expect(entries).toContain('revive')
    expect(entries).not.toContain('ghost')
    expect(entries).not.toContain('ghost!')
  })

  it('puts spelling suggestions and Add to dictionary first', () => {
    expect(
      tokens(
        editorContextMenuEntries({
          ...BASE,
          spelling: { misspelledWord: 'teh', dictionarySuggestions: ['the', 'ten'] }
        })
      ).slice(0, 5)
    ).toEqual(['spell:the', 'spell:ten', 'addToDictionary', '---', 'cut'])
  })

  it('says there are no suggestions for a misspelling the dictionary cannot fix', () => {
    expect(
      tokens(
        editorContextMenuEntries({
          ...BASE,
          spelling: { misspelledWord: 'qzx', dictionarySuggestions: [] }
        })
      ).slice(0, 3)
    ).toEqual(['spell:none', 'addToDictionary', '---'])
  })
})

describe('EditorContextMenu', () => {
  it('renders the entries as a keyboard-navigable menu and runs the chosen action', async () => {
    const user = userEvent.setup()
    const onAction = vi.fn()
    const onReplaceSpelling = vi.fn()
    render(
      <EditorContextMenu
        x={10}
        y={10}
        entries={editorContextMenuEntries({
          ...BASE,
          hasSelection: false,
          canAddAlternative: false,
          spelling: { misspelledWord: 'teh', dictionarySuggestions: ['the'] }
        })}
        onAction={onAction}
        onReplaceSpelling={onReplaceSpelling}
        onClose={vi.fn()}
      />
    )

    const menu = await screen.findByRole('menu')
    await waitFor(() => expect(menu).toHaveFocus())
    expect(screen.getByRole('menuitem', { name: /^Cut/ })).toHaveAttribute('data-disabled')
    expect(screen.getByRole('menuitem', { name: /^Add alternative/ })).toHaveAttribute(
      'data-disabled'
    )

    // Down from the menu lands on the first enabled item: the suggestion.
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'the' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onReplaceSpelling).toHaveBeenCalledWith('the')

    await user.click(screen.getByRole('menuitem', { name: /^Paste/ }))
    expect(onAction).toHaveBeenCalledWith('paste')
  })
})

describe('findWordAt', () => {
  it('picks the occurrence under the click among repeats', () => {
    const text = 'teh cat and teh dog'
    expect(findWordAt(text, 13, 'teh')).toEqual({ start: 12, end: 15 })
    expect(findWordAt(text, 1, 'teh')).toEqual({ start: 0, end: 3 })
  })

  it('falls back to the nearest occurrence and to null when absent', () => {
    expect(findWordAt('teh cat', 6, 'teh')).toEqual({ start: 0, end: 3 })
    expect(findWordAt('the cat', 2, 'teh')).toBeNull()
  })
})
