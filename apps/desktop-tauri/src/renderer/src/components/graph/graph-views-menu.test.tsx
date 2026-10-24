import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { GRAPH_VIEW_STATE_DEFAULTS, type SavedGraphView } from '@memry/contracts/graph-api'
import { GraphViewsMenu } from './graph-views-menu'

let i18nEn: I18nInstance

beforeAll(async () => {
  i18nEn = await createRendererI18n({ locale: 'en' })
})

const view = (id: string, name: string): SavedGraphView => ({
  id,
  name,
  state: GRAPH_VIEW_STATE_DEFAULTS,
  layout: 'forceatlas2',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
})

function renderMenu(props: Partial<React.ComponentProps<typeof GraphViewsMenu>> = {}) {
  const handlers = {
    onApply: vi.fn(),
    onSaveAs: vi.fn(() => true),
    onUpdate: vi.fn(),
    onDelete: vi.fn()
  }
  render(
    <I18nextProvider i18n={i18nEn}>
      <GraphViewsMenu views={[]} activeView={null} isModified={false} {...handlers} {...props} />
    </I18nextProvider>
  )
  return handlers
}

const openMenu = (): void => {
  fireEvent.pointerDown(screen.getByTestId('graph-views-trigger'), { button: 0, ctrlKey: false })
}

describe('GraphViewsMenu', () => {
  it('shows an unsaved view with an empty list', () => {
    renderMenu()
    expect(screen.getByTestId('graph-views-trigger')).toHaveTextContent('Unsaved view')
    openMenu()
    expect(screen.getByText('No saved views yet')).toBeInTheDocument()
  })

  it('saves the current view under a non-empty name', () => {
    const handlers = renderMenu()
    openMenu()
    fireEvent.click(screen.getByTestId('graph-views-save-as'))

    const input = screen.getByTestId('graph-views-save-name')
    expect(screen.getByTestId('graph-views-save-confirm')).toBeDisabled()
    fireEvent.change(input, { target: { value: 'Work only' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(handlers.onSaveAs).toHaveBeenCalledWith('Work only')
    expect(screen.queryByTestId('graph-views-save-name')).not.toBeInTheDocument()
  })

  it('keeps the dialog open when saving fails', () => {
    const onSaveAs = vi.fn(() => false)
    renderMenu({ onSaveAs })
    openMenu()
    fireEvent.click(screen.getByTestId('graph-views-save-as'))
    fireEvent.change(screen.getByTestId('graph-views-save-name'), { target: { value: 'X' } })
    fireEvent.click(screen.getByTestId('graph-views-save-confirm'))
    expect(onSaveAs).toHaveBeenCalledWith('X')
    expect(screen.getByTestId('graph-views-save-name')).toBeInTheDocument()
  })

  it('applies, updates and deletes saved views', () => {
    const work = view('v1', 'Work')
    const home = view('v2', 'Home')
    const handlers = renderMenu({ views: [work, home], activeView: work, isModified: true })

    expect(screen.getByTestId('graph-views-trigger')).toHaveTextContent('Work')
    expect(screen.getByTestId('graph-views-trigger')).toHaveTextContent('Edited')

    openMenu()
    fireEvent.click(screen.getByText('Home'))
    expect(handlers.onApply).toHaveBeenCalledWith(home)

    openMenu()
    fireEvent.click(screen.getByText('Update “Work”'))
    expect(handlers.onUpdate).toHaveBeenCalledWith(work)

    openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Delete view Home' }))
    expect(handlers.onDelete).toHaveBeenCalledWith(home)
    expect(handlers.onApply).toHaveBeenCalledTimes(1)
  })
})
