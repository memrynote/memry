import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WikiLinkContextMenu } from './wiki-link-context-menu'

const loadCard = vi.hoisted(() => vi.fn())
vi.mock('./wiki-link-card-data', () => ({ loadWikiLinkCardContent: loadCard }))

function noteWith(cover: object | null) {
  return { icon: null, text: null, cover }
}

type DisplayProps = ComponentProps<typeof WikiLinkContextMenu>['display']

beforeEach(() => {
  loadCard.mockReset()
  loadCard.mockResolvedValue(noteWith({ kind: 'wash', gradient: 'linear-gradient(red, blue)' }))
})

async function openMenu(options: {
  display: DisplayProps
  editable?: boolean
  onDisplayChange?: (patch: object) => void
}) {
  render(
    <WikiLinkContextMenu
      x={10}
      y={10}
      target="Dune"
      editable={options.editable ?? true}
      display={options.display}
      onAction={vi.fn()}
      onDisplayChange={options.onDisplayChange ?? vi.fn()}
      onClose={vi.fn()}
    />
  )
  await screen.findByTestId('wiki-link-context-menu')
}

/** The Display row opens the settings panel beside the menu, like a submenu. */
async function openPanel() {
  fireEvent.keyDown(screen.getByRole('menuitem', { name: /Display/ }), { key: 'ArrowRight' })
  return screen.findByTestId('wiki-link-display-panel')
}

describe('WikiLinkContextMenu display settings (#2845)', () => {
  it('offers one Display row, not the settings themselves, for a link alone in its paragraph', async () => {
    await openMenu({ display: { size: 'none', cover: false, preview: false } })

    expect(screen.getByRole('menuitem', { name: 'Open' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Display/ })).toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitemradio')).not.toBeInTheDocument()
  })

  it('hides the Display row for a link inside running text', async () => {
    await openMenu({ display: null })

    expect(screen.getByRole('menuitem', { name: 'Open' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /Display/ })).not.toBeInTheDocument()
  })

  it('hides it in a read-only editor, where nothing may be written', async () => {
    await openMenu({
      display: { size: 'none', cover: false, preview: false },
      editable: false
    })

    expect(screen.queryByRole('menuitem', { name: /Display/ })).not.toBeInTheDocument()
  })

  it('shows the current settings in the panel', async () => {
    await openMenu({ display: { size: 'medium', cover: true, preview: false } })
    const panel = await openPanel()

    expect(panel).not.toHaveTextContent('Display')
    expect(screen.getByRole('radio', { name: 'Medium' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Small' })).not.toBeChecked()
    expect(await screen.findByRole('switch', { name: 'Show cover' })).toBeChecked()
    expect(screen.getByRole('switch', { name: 'Show preview' })).not.toBeChecked()
  })

  it('reports the size a user picks, and shows it without reopening the menu', async () => {
    const onDisplayChange = vi.fn()
    await openMenu({ display: { size: 'none', cover: false, preview: false }, onDisplayChange })
    await openPanel()

    fireEvent.click(screen.getByRole('radio', { name: 'Small' }))

    expect(onDisplayChange).toHaveBeenCalledWith({ size: 'small' })
    expect(screen.getByRole('radio', { name: 'Small' })).toBeChecked()
  })

  it('keeps the panel open across several changes', async () => {
    const onDisplayChange = vi.fn()
    await openMenu({ display: { size: 'small', cover: false, preview: true }, onDisplayChange })
    await openPanel()

    fireEvent.click(screen.getByRole('switch', { name: 'Show preview' }))
    expect(onDisplayChange).toHaveBeenLastCalledWith({ preview: false })

    fireEvent.click(await screen.findByRole('switch', { name: 'Show cover' }))
    expect(onDisplayChange).toHaveBeenLastCalledWith({ cover: true })
    expect(screen.getByTestId('wiki-link-display-panel')).toBeInTheDocument()
  })

  it('does not offer Show cover for a plain chip, which has no room for one', async () => {
    await openMenu({ display: { size: 'none', cover: false, preview: false } })
    await openPanel()

    await screen.findByRole('switch', { name: 'Show preview' })
    await waitFor(() => {
      expect(loadCard).toHaveBeenCalled()
    })
    expect(screen.queryByRole('switch', { name: 'Show cover' })).not.toBeInTheDocument()
  })

  it('offers Show cover once a size is picked, and drops it again on None', async () => {
    await openMenu({ display: { size: 'none', cover: false, preview: false } })
    await openPanel()

    fireEvent.click(screen.getByRole('radio', { name: 'Small' }))
    expect(await screen.findByRole('switch', { name: 'Show cover' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'None' }))
    expect(screen.queryByRole('switch', { name: 'Show cover' })).not.toBeInTheDocument()
  })

  it('hides the Show cover switch when the linked note has no cover to show', async () => {
    loadCard.mockResolvedValue(noteWith(null))
    await openMenu({ display: { size: 'medium', cover: true, preview: false } })
    await openPanel()

    await screen.findByRole('switch', { name: 'Show preview' })
    expect(screen.queryByRole('switch', { name: 'Show cover' })).not.toBeInTheDocument()
  })

  it('hides it for a note that cannot be found, and while the note is still loading', async () => {
    loadCard.mockReturnValue(new Promise(() => {}))
    await openMenu({ display: { size: 'medium', cover: false, preview: false } })
    await openPanel()

    expect(screen.getByRole('switch', { name: 'Show preview' })).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Show cover' })).not.toBeInTheDocument()

    loadCard.mockResolvedValue(null)
  })

  it('asks for the cover of the note the link names', async () => {
    await openMenu({ display: { size: 'small', cover: false, preview: false } })
    await openPanel()

    expect(loadCard).toHaveBeenCalledWith('Dune')
    expect(await screen.findByRole('switch', { name: 'Show cover' })).toBeInTheDocument()
  })
})
