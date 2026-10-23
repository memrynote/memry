import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PortalPicker } from './portal-picker'
import type { PortalPickerItem } from './portal-picker-model'

const editorElement = document.createElement('div')

vi.mock('@blocknote/react', () => ({
  useBlockNoteEditor: () => ({ domElement: editorElement })
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: { query?: string }) => {
      const messages: Record<string, string> = {
        'portalFlows.picker.notes': 'Notes',
        'portalFlows.picker.blocks': 'Blocks',
        'portalFlows.picker.empty': 'No notes or blocks match',
        'portalFlows.picker.hintInsert': 'Insert portal',
        'portalFlows.picker.hintClose': 'Close',
        'portalFlows.picker.keyEsc': 'Esc',
        'portalFlows.picker.create': `Create note “${values?.query}”`
      }
      return messages[key] ?? key
    }
  })
}))

const note: PortalPickerItem = {
  kind: 'note',
  key: 'note:n1',
  noteId: 'n1',
  title: 'Cell Biology',
  folder: 'Lectures / Biology',
  emoji: '🧬'
}
const block: PortalPickerItem = {
  kind: 'block',
  key: 'block:n2:b1',
  noteId: 'n2',
  noteTitle: 'Biology Textbook',
  parentText: null,
  blockId: 'b1',
  anchor: null,
  title: 'Chloroplast converts light energy into sugar',
  query: 'light'
}
const create: PortalPickerItem = { kind: 'create', key: 'create', title: 'light' }

const renderPicker = (items: PortalPickerItem[], selectedIndex: number | undefined) => {
  const onItemClick = vi.fn()
  render(
    <PortalPicker
      items={items}
      loadingState="loaded"
      selectedIndex={selectedIndex}
      onItemClick={onItemClick}
    />
  )
  return { onItemClick }
}

const pressCmdEnter = () => {
  const target = document.createElement('p')
  editorElement.appendChild(target)
  fireEvent.keyDown(target, { key: 'Enter', metaKey: true })
}

beforeEach(() => document.body.appendChild(editorElement))
afterEach(() => {
  editorElement.replaceChildren()
  editorElement.remove()
  vi.clearAllMocks()
})

describe('PortalPicker', () => {
  it('lists blocks before notes, each with its path, and bolds the query in a block', () => {
    renderPicker([block, note, create], 0)
    const headings = screen.getAllByText(/^(Blocks|Notes)$/).map((el) => el.textContent)
    expect(headings).toEqual(['Blocks', 'Notes'])
    expect(screen.getByText('Biology Textbook')).toBeTruthy()
    expect(screen.getByText('Lectures / Biology')).toBeTruthy()
    expect(screen.getByText('light', { selector: 'strong' })).toBeTruthy()
  })

  it('shows the note’s own emoji in front of a note row', () => {
    renderPicker([note], 0)
    expect(screen.getByRole('option', { name: /Cell Biology/ }).textContent).toContain('🧬')
  })

  it('picks the clicked row', () => {
    const { onItemClick } = renderPicker([block, note], 0)
    fireEvent.click(screen.getByRole('option', { name: /Cell Biology/ }))
    expect(onItemClick).toHaveBeenCalledWith(note)
  })

  it('offers Create note with its keycaps, and Cmd+Enter picks it whatever is highlighted', () => {
    const { onItemClick } = renderPicker([block, create], 0)
    const row = screen.getByRole('option', { name: /Create note “light”/ })
    expect(row.textContent).toContain('⌘')
    pressCmdEnter()
    expect(onItemClick).toHaveBeenCalledWith(create)
  })

  it('Cmd+Enter does nothing without a query', () => {
    const { onItemClick } = renderPicker([block, note], 0)
    pressCmdEnter()
    expect(onItemClick).not.toHaveBeenCalled()
  })

  it('shows the empty state when nothing matches', () => {
    renderPicker([], undefined)
    expect(screen.getByText('No notes or blocks match')).toBeTruthy()
  })
})
