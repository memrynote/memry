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

const CATALOG: Item[] = [{ title: 'Divider', aliases: ['horizontal rule'] }]

const getItems = async (query: string): Promise<Item[]> =>
  CATALOG.filter((item) => [item.title, ...item.aliases].some((name) => name.includes(query)))

function Menu({ items, loadingState }: SuggestionMenuProps<Item>): ReactNode {
  return (
    <div data-testid="slash-menu">
      {loadingState === 'loaded' && items.length === 0 ? 'no match' : items.map((i) => i.title)}
    </div>
  )
}

function renderSlashMenu(): BlockNoteEditor {
  const editor = BlockNoteEditor.create()
  render(
    <BlockNoteView editor={editor} slashMenu={false}>
      <SlashMenuController
        getItems={getItems}
        suggestionMenuComponent={Menu}
        onItemClick={vi.fn()}
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
})
