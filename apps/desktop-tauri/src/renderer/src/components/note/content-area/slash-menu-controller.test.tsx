/**
 * #4205: `/zqxv` typed faster than React renders reached the menu as one query, so BlockNote never
 * saw `/z` match and closed the menu; Enter then split the paragraph.
 */

import { BlockNoteEditor } from '@blocknote/core'
import { SuggestionMenu } from '@blocknote/core/extensions'
import { BlockNoteView } from '@blocknote/shadcn'
import type { SuggestionMenuProps } from '@blocknote/react'
import { act, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SlashMenuController } from './slash-menu-controller'

type Item = { title: string; aliases: string[] }

const CATALOG: Item[] = [
  { title: 'Divider', aliases: ['horizontal rule'] },
  { title: 'Check List', aliases: ['checkbox'] }
]

const getItems = async (query: string): Promise<Item[]> =>
  CATALOG.filter((item) =>
    [item.title, ...item.aliases].some((name) => name.toLowerCase().includes(query))
  )

function Menu({ items, loadingState }: SuggestionMenuProps<Item>): ReactNode {
  return (
    <div data-testid="slash-menu">
      {loadingState === 'loaded' && items.length === 0
        ? 'no match'
        : items.map((i) => <span key={i.title}>{i.title}</span>)}
    </div>
  )
}

function renderSlashMenu(
  lookup: (query: string) => Promise<Item[]> = getItems,
  onItemClick: (item: Item) => void = vi.fn()
): BlockNoteEditor {
  const editor = BlockNoteEditor.create()
  render(
    <BlockNoteView editor={editor} slashMenu={false}>
      <SlashMenuController
        getItems={lookup}
        suggestionMenuComponent={Menu}
        onItemClick={onItemClick}
      />
    </BlockNoteView>
  )
  return editor
}

/** Types every character before React renders, as fast typing or a slow frame does. */
function typeInOneRender(editor: BlockNoteEditor, text: string): void {
  act(() => {
    for (const char of text) editor.transact((tr) => tr.insertText(char))
  })
}

const menuShown = (editor: BlockNoteEditor): boolean => editor.getExtension(SuggestionMenu)!.shown()

describe('SlashMenuController', () => {
  // jsdom's rects have no `toJSON`, which BlockNote's menu view calls to place the menu.
  beforeEach(() => {
    const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      ...rect,
      toJSON: () => rect
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it('keeps the menu open when a prefix of a no-match query matched', async () => {
    const editor = renderSlashMenu()
    act(() => editor.getExtension(SuggestionMenu)!.openSuggestionMenu('/'))
    await screen.findByText('Divider')

    typeInOneRender(editor, 'zqxv')

    expect(await screen.findByText('no match')).toBeInTheDocument()
    // Let every pending lookup settle before reading the outcome.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(menuShown(editor)).toBe(true)
  })

  it('closes once 4 characters in a row match nothing', async () => {
    const editor = renderSlashMenu()
    act(() => editor.getExtension(SuggestionMenu)!.openSuggestionMenu('/'))
    await screen.findByText('Divider')

    typeInOneRender(editor, 'zqxvw')

    await waitFor(() => expect(menuShown(editor)).toBe(false))
  })

  // #4245: Enter ran the selected row of the last list that finished loading, so `/check` typed and
  // entered before its lookup returned inserted Divider, the first row of `/`.
  it('runs Enter on the rows of the current query, not of a list still loading', async () => {
    let releaseCheck: () => void = () => {}
    const checkLoaded = new Promise<void>((resolve) => (releaseCheck = resolve))
    const lookup = async (query: string): Promise<Item[]> => {
      if (query === 'check') await checkLoaded
      return getItems(query)
    }
    const onItemClick = vi.fn()
    const editor = renderSlashMenu(lookup, onItemClick)
    act(() => editor.getExtension(SuggestionMenu)!.openSuggestionMenu('/'))
    await screen.findByText('Check List')

    typeInOneRender(editor, 'check')
    act(() => {
      editor.prosemirrorView.dom.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
    })
    expect(onItemClick).not.toHaveBeenCalled()

    await act(async () => releaseCheck())
    await waitFor(() => expect(onItemClick).toHaveBeenCalledTimes(1))
    expect(onItemClick).toHaveBeenCalledWith(CATALOG[1])
  })

  it('drops an Enter whose query changed again before its rows loaded', async () => {
    let releaseCheck: () => void = () => {}
    const checkLoaded = new Promise<void>((resolve) => (releaseCheck = resolve))
    const lookup = async (query: string): Promise<Item[]> => {
      if (query.startsWith('check')) await checkLoaded
      return getItems(query)
    }
    const onItemClick = vi.fn()
    const editor = renderSlashMenu(lookup, onItemClick)
    act(() => editor.getExtension(SuggestionMenu)!.openSuggestionMenu('/'))
    await screen.findByText('Check List')

    typeInOneRender(editor, 'check')
    act(() => {
      editor.prosemirrorView.dom.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
    })
    typeInOneRender(editor, 'b')
    await act(async () => releaseCheck())
    await screen.findByText('Check List')

    expect(onItemClick).not.toHaveBeenCalled()
  })
})
