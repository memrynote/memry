import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SlashMenu, SlashMenuFallbackContext, type SlashMenuFallbacks } from './slash-menu'
import { readSlashMenuRecents, type SlashMenuItem } from './slash-menu-model'

const suggestionMenu = { closeMenu: vi.fn(), clearQuery: vi.fn() }
const editorElement = document.createElement('div')
let query = ''

vi.mock('@blocknote/react', () => ({
  useBlockNoteEditor: () => ({
    domElement: editorElement,
    getExtension: () => suggestionMenu
  }),
  useExtensionState: () => query
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: { query?: string }) => {
      const messages: Record<string, string> = {
        'editor.slashMenu.actions.insert': 'Insert',
        'editor.slashMenu.actions.open': 'Open',
        'editor.slashMenu.matchesAlias': 'matches',
        'editor.slashMenu.noMatch': `No blocks match “${values?.query ?? ''}”`,
        'editor.slashMenu.fallback.linkTo': 'Link to',
        'editor.slashMenu.fallback.askAI': 'Ask AI'
      }
      return messages[key] ?? key
    }
  })
}))

const toggleHeading = vi.fn()

const items = (): SlashMenuItem[] => [
  {
    id: 'heading_2',
    title: 'Heading 2',
    group: 'Blocks',
    hint: '##',
    subtext: 'Medium section heading',
    match: { start: 0, end: 4 },
    secondary: { label: 'As toggle', onItemClick: toggleHeading },
    onItemClick: vi.fn()
  },
  {
    id: 'task',
    title: 'Task',
    group: 'Insert',
    matchedAlias: 'todo',
    onItemClick: vi.fn()
  }
]

const pressInEditor = (init: KeyboardEventInit) => {
  const target = document.createElement('p')
  editorElement.appendChild(target)
  fireEvent.keyDown(target, init)
}

beforeEach(() => {
  document.body.appendChild(editorElement)
  query = ''
})

afterEach(() => {
  editorElement.replaceChildren()
  editorElement.remove()
  localStorage.clear()
  vi.clearAllMocks()
})

describe('SlashMenu', () => {
  it('renders groups, the shortcut lane, alias hints and the selected row footer', () => {
    render(<SlashMenu items={items()} loadingState="loaded" selectedIndex={0} />)

    expect(screen.getByText('Blocks')).toBeInTheDocument()
    expect(screen.getByText('Insert', { selector: 'div' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Heading 2' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByText('##')).toBeInTheDocument()
    expect(screen.getByText('todo')).toBeInTheDocument()
    expect(screen.getByText('Medium section heading')).toBeInTheDocument()
    expect(screen.getByText('As toggle')).toBeInTheDocument()
  })

  it('runs a row on click', () => {
    const onItemClick = vi.fn()
    const list = items()
    render(
      <SlashMenu items={list} loadingState="loaded" selectedIndex={0} onItemClick={onItemClick} />
    )

    fireEvent.click(screen.getByRole('option', { name: 'Task' }))
    expect(onItemClick).toHaveBeenCalledWith(list[1])
  })

  it('runs the secondary action on Cmd/Ctrl+Enter and records the row as recent', () => {
    render(<SlashMenu items={items()} loadingState="loaded" selectedIndex={0} />)

    pressInEditor({ key: 'Enter', metaKey: true })
    pressInEditor({ key: 'Enter', ctrlKey: true })

    expect(toggleHeading).toHaveBeenCalledTimes(2)
    expect(suggestionMenu.closeMenu).toHaveBeenCalled()
    expect(suggestionMenu.clearQuery).toHaveBeenCalled()
    expect(readSlashMenuRecents()).toEqual(['heading_2'])
  })

  it('leaves plain Enter and rows without a secondary action to BlockNote', () => {
    render(<SlashMenu items={items()} loadingState="loaded" selectedIndex={1} />)

    pressInEditor({ key: 'Enter', metaKey: true })
    pressInEditor({ key: 'Enter' })

    expect(toggleHeading).not.toHaveBeenCalled()
    expect(suggestionMenu.closeMenu).not.toHaveBeenCalled()
  })

  it('ignores keys typed outside the editor', () => {
    render(<SlashMenu items={items()} loadingState="loaded" selectedIndex={0} />)

    fireEvent.keyDown(document.body, { key: 'Enter', metaKey: true })
    expect(toggleHeading).not.toHaveBeenCalled()
  })

  it('offers the query to note search and AI when nothing matches', () => {
    query = 'sprint retro'
    const fallbacks: SlashMenuFallbacks = { linkToNote: vi.fn(), askAI: vi.fn() }
    render(
      <SlashMenuFallbackContext value={fallbacks}>
        <SlashMenu items={[]} loadingState="loaded" selectedIndex={undefined} />
      </SlashMenuFallbackContext>
    )

    expect(screen.getByText('No blocks match “sprint retro”')).toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(2)

    pressInEditor({ key: 'ArrowDown' })
    pressInEditor({ key: 'Enter' })

    expect(fallbacks.askAI).toHaveBeenCalledTimes(1)
    expect(fallbacks.linkToNote).not.toHaveBeenCalled()
    expect(suggestionMenu.clearQuery).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('option', { name: /Link to/ }))
    expect(fallbacks.linkToNote).toHaveBeenCalledWith('sprint retro')
  })

  it('renders nothing while the first items load', () => {
    const { container } = render(
      <SlashMenu items={[]} loadingState="loading-initial" selectedIndex={undefined} />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
