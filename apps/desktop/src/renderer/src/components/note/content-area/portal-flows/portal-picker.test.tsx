import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PortalPicker, PortalPickerContext } from './portal-picker'
import type { PortalPickerItem } from './portal-picker-model'

const suggestionMenu = { closeMenu: vi.fn(), clearQuery: vi.fn() }
const editorElement = document.createElement('div')

vi.mock('@blocknote/react', () => ({
  useBlockNoteEditor: () => ({ domElement: editorElement, getExtension: () => suggestionMenu })
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => {
      const messages: Record<string, string> = {
        'portalFlows.picker.notes': 'Notes',
        'portalFlows.picker.blocks': 'Blocks',
        'portalFlows.picker.empty': 'No notes or blocks match',
        'portalFlows.picker.hintInsert': 'Insert portal',
        'portalFlows.picker.hintChildren': 'Choose blocks to show',
        'portalFlows.picker.keyTab': 'Tab'
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
  blockId: 'b1',
  anchor: null,
  title: 'Chloroplast converts light energy into sugar'
}

const renderPicker = (items: PortalPickerItem[], selectedIndex: number | undefined) => {
  const onItemClick = vi.fn()
  const pickWithChildren = vi.fn()
  render(
    <PortalPickerContext value={{ pickWithChildren }}>
      <PortalPicker
        items={items}
        loadingState="loaded"
        selectedIndex={selectedIndex}
        onItemClick={onItemClick}
      />
    </PortalPickerContext>
  )
  return { onItemClick, pickWithChildren }
}

const pressTab = () => {
  const target = document.createElement('p')
  editorElement.appendChild(target)
  fireEvent.keyDown(target, { key: 'Tab' })
}

beforeEach(() => document.body.appendChild(editorElement))
afterEach(() => {
  editorElement.replaceChildren()
  editorElement.remove()
  vi.clearAllMocks()
})

describe('PortalPicker', () => {
  it('lists notes and blocks together under their own headings', () => {
    renderPicker([note, block], 0)
    expect(screen.getByText('Notes')).toBeTruthy()
    expect(screen.getByText('Blocks')).toBeTruthy()
    expect(screen.getByRole('option', { name: /Cell Biology/ })).toBeTruthy()
    expect(screen.getByText('Biology Textbook')).toBeTruthy()
  })

  it('shows the note’s own emoji in front of a note row', () => {
    renderPicker([note], 0)
    expect(screen.getByRole('option', { name: /Cell Biology/ }).textContent).toContain('🧬')
  })

  it('picks the clicked row', () => {
    const { onItemClick } = renderPicker([note, block], 0)
    fireEvent.click(screen.getByRole('option', { name: /Chloroplast/ }))
    expect(onItemClick).toHaveBeenCalledWith(block)
  })

  it('Tab on a selected block inserts it with its children list open', () => {
    const { pickWithChildren } = renderPicker([note, block], 1)
    pressTab()
    expect(pickWithChildren).toHaveBeenCalledWith(block)
    expect(suggestionMenu.closeMenu).toHaveBeenCalled()
    expect(suggestionMenu.clearQuery).toHaveBeenCalled()
  })

  it('Tab on a selected note inserts it with its block list open too', () => {
    const { pickWithChildren } = renderPicker([note, block], 0)
    pressTab()
    expect(pickWithChildren).toHaveBeenCalledWith(note)
  })

  it('shows the empty state when nothing matches', () => {
    renderPicker([], undefined)
    expect(screen.getByText('No notes or blocks match')).toBeTruthy()
  })
})
