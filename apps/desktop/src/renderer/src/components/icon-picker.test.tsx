import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getIconByName, IconPicker } from './icon-picker'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => key
  })
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn()
  })
}))

describe('IconPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'innerWidth', { value: 360, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 420, configurable: true })
  })

  it('exports icon lookups and stays hidden when closed', () => {
    expect(getIconByName('File')).toBeDefined()
    expect(getIconByName('MissingIcon')).toBeUndefined()

    const { container } = render(<IconPicker isOpen={false} onClose={vi.fn()} onSelect={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('filters categories, selects and clears icons, and closes from controls', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onSelect = vi.fn()

    render(
      <IconPicker
        isOpen
        onClose={onClose}
        onSelect={onSelect}
        currentIcon="File"
        position={{ x: 500, y: -20 }}
      />
    )

    expect(
      screen.getByRole('dialog', { name: 'phaseF.componentsIconPicker.iconPicker' })
    ).toHaveStyle({ left: '24px', top: '16px' })

    await user.click(screen.getByRole('button', { name: 'Folders' }))
    expect(screen.getAllByText('Folders')).toHaveLength(2)
    expect(screen.queryByText('Files & Documents')).not.toBeInTheDocument()

    await user.type(
      screen.getByPlaceholderText('phaseF.componentsIconPicker.searchIcons'),
      'folder'
    )
    expect(screen.getByRole('button', { name: 'Select Folder icon' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Select Folder icon' }))
    expect(onSelect).toHaveBeenCalledWith('Folder')
    expect(onClose).toHaveBeenCalledTimes(1)

    await user.click(screen.getByText('phaseF.componentsIconPicker.clearIcon'))
    expect(onSelect).toHaveBeenLastCalledWith('')

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('shows empty search results and closes on outside click', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()

    render(<IconPicker isOpen onClose={onClose} onSelect={vi.fn()} />)

    await user.type(screen.getByPlaceholderText('phaseF.componentsIconPicker.searchIcons'), 'zzzz')
    expect(screen.getByText(/phaseF.componentsIconPicker.noIconsFoundFor/)).toBeInTheDocument()

    fireEvent.mouseDown(document.body)
    expect(onClose).toHaveBeenCalledOnce()
  })
})

describe('IconPicker inside a modal layer', () => {
  it('re-enables pointer events on its overlay root', () => {
    render(<IconPicker isOpen onClose={vi.fn()} onSelect={vi.fn()} position={{ x: 10, y: 10 }} />)

    // A modal Radix Dialog sets body { pointer-events: none }; the picker must opt
    // back in or its controls are dead and every click reads as "outside".
    expect(screen.getByRole('dialog').className).toContain('pointer-events-auto')
  })

  it('stops pointer-down and focus from reaching the host (keeps the parent dialog open)', () => {
    const hostPointerDown = vi.fn()
    const hostFocus = vi.fn()

    render(
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions
      <div onPointerDown={hostPointerDown} onFocus={hostFocus}>
        <IconPicker isOpen onClose={vi.fn()} onSelect={vi.fn()} position={{ x: 10, y: 10 }} />
      </div>
    )

    const search = screen.getByPlaceholderText('phaseF.componentsIconPicker.searchIcons')
    fireEvent.pointerDown(search)
    fireEvent.focus(search)

    expect(hostPointerDown).not.toHaveBeenCalled()
    expect(hostFocus).not.toHaveBeenCalled()
  })
})
