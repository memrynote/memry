import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useReducer } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FoldLevel } from '@memry/contracts/note-fold'
import { buildFoldedView } from './fold-display'
import { layers, paragraph } from './fold-fixtures'
import { FoldLevelControl } from './fold-level-control'
import { FoldBody } from './fold-overlay'
import { FoldPill } from './fold-pill'
import { foldReducer, INITIAL_FOLD_STATE } from './fold-state'

function Folded({ level }: { level: FoldLevel }) {
  const [state, dispatch] = useReducer(foldReducer, { ...INITIAL_FOLD_STATE, level })
  const view = buildFoldedView(layers(), level, state.opened, state.unfoldedSections)
  return (
    <>
      <FoldBody view={view} dispatch={dispatch} />
      <output data-testid="level">{state.level}</output>
      <output data-testid="anchor">{state.anchor ?? ''}</output>
    </>
  )
}

describe('FoldBody', () => {
  it('opens a paragraph in place on click and folds it on the second click', async () => {
    render(<Folded level="takeaway" />)
    expect(screen.queryByText('Opened to Full · click again to fold')).toBeNull()

    await userEvent.click(screen.getByText('Pro stays at $8'))
    expect(screen.getByText('Opened to Full · click again to fold')).toBeInTheDocument()
    expect(screen.getByRole('button', { expanded: true })).toHaveTextContent(
      /Second sentence here\./
    )
    expect(screen.getByText('The team plan barely sold')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { expanded: true }))
    expect(screen.queryByText('Opened to Full · click again to fold')).toBeNull()
  })

  it('renders Brief inline Markdown as elements, never as HTML or a link', () => {
    const rich = layers()
    rich.sections[0].paragraphs[0] = paragraph({
      hash: 'p1',
      sentencesMd: [
        '**First** sentence [here](https://x.test).',
        'Second',
        '<b>Third</b> sentence here.'
      ]
    })
    rich.sections[0].skipped = [
      { afterParagraph: 0, kind: 'code', count: 1 },
      { afterParagraph: 1, kind: 'image', count: 2 }
    ]
    const view = buildFoldedView(rich, 'brief', new Set(), new Set())
    const { container } = render(<FoldBody view={view} dispatch={() => {}} />)
    expect(screen.getByText('First', { selector: 'strong' })).toBeInTheDocument()
    expect(container.querySelector('a, b')).toBeNull()
    expect(container).toHaveTextContent('<b>Third</b> sentence here.')
    expect(screen.getByText('… 1 code block')).toBeInTheDocument()
    expect(screen.getByText('… 2 images')).toBeInTheDocument()
  })

  it('shows no skipped-block marker on Topic cards', () => {
    const note = layers()
    note.sections[0].skipped = [{ afterParagraph: 0, kind: 'code', count: 1 }]
    const view = buildFoldedView(note, 'topic', new Set(), new Set())
    render(<FoldBody view={view} dispatch={() => {}} />)
    expect(screen.queryByText('… 1 code block')).toBeNull()
  })

  it('jumps from a Topic chip to Full on that paragraph', async () => {
    render(<Folded level="topic" />)
    await userEvent.click(screen.getByRole('button', { name: /team plan sales/ }))
    expect(screen.getByTestId('level')).toHaveTextContent('full')
    expect(screen.getByTestId('anchor')).toHaveTextContent('p1')
  })

  it('unfolds one section from its card heading and folds it back', async () => {
    render(<Folded level="topic" />)
    const heading = { name: 'Unfold the section Where we are' }
    await userEvent.click(screen.getByRole('button', heading))
    const fullText = /Second sentence here\. Third sentence here\./
    expect(screen.getAllByText(fullText)).toHaveLength(2)

    await userEvent.click(screen.getByRole('button', heading))
    expect(screen.queryAllByText(fullText)).toHaveLength(0)
  })
})

describe('FoldLevelControl', () => {
  const HINT_KEY = 'memry:note-fold-hint-seen'

  beforeEach(() => localStorage.setItem(HINT_KEY, '1'))

  function renderControl(overrides: Partial<Parameters<typeof FoldLevelControl>[0]> = {}) {
    const props = {
      layers: layers(),
      requested: 'full' as FoldLevel,
      level: 'full' as FoldLevel,
      onSelectLevel: vi.fn(),
      ...overrides
    }
    render(<FoldLevelControl {...props} />)
    return props
  }

  it('is an icon at Full and folds to Brief on click', async () => {
    const props = renderControl()
    const control = screen.getByRole('button', { name: 'Fold note' })
    expect(control).toHaveTextContent('')
    await userEvent.click(control)
    expect(props.onSelectLevel).toHaveBeenCalledWith('brief')
  })

  it('names the level when folded and returns to Full on click', async () => {
    const props = renderControl({ requested: 'key', level: 'key' })
    expect(screen.getByTestId('note-fold-level')).toHaveTextContent('Key')
    await userEvent.click(screen.getByRole('button', { name: /Folded to Key/ }))
    expect(props.onSelectLevel).toHaveBeenCalledWith('full')
  })

  it('shows the word count and shortcut in the tooltip', async () => {
    renderControl()
    await userEvent.hover(screen.getByRole('button', { name: 'Fold note' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Fold note · 1,104 words')
  })

  it('hints once on a long note and stays quiet after it is dismissed', async () => {
    localStorage.removeItem(HINT_KEY)
    const { unmount } = render(
      <FoldLevelControl layers={layers()} requested="full" level="full" onSelectLevel={vi.fn()} />
    )
    expect(await screen.findByTestId('note-fold-hint')).toHaveTextContent('Long note? Skim it.')

    await userEvent.click(screen.getByRole('button', { name: 'Got it' }))
    expect(screen.queryByTestId('note-fold-hint')).toBeNull()

    unmount()
    render(
      <FoldLevelControl layers={layers()} requested="full" level="full" onSelectLevel={vi.fn()} />
    )
    expect(screen.queryByTestId('note-fold-hint')).toBeNull()
  })

  it('counts folding as having seen the hint', async () => {
    localStorage.removeItem(HINT_KEY)
    renderControl()
    await userEvent.click(await screen.findByRole('button', { name: 'Fold note' }))
    expect(localStorage.getItem(HINT_KEY)).toBe('1')
  })
})

describe('FoldPill', () => {
  function renderPill(overrides: Partial<Parameters<typeof FoldPill>[0]> = {}) {
    const props = {
      layers: layers(),
      level: 'brief' as const,
      openCount: 0,
      onSelectLevel: vi.fn(),
      onRetry: vi.fn(),
      onCopy: vi.fn().mockResolvedValue(undefined),
      ...overrides
    }
    render(<FoldPill {...props} />)
    return props
  }

  it('switches level with one click and marks the current one', async () => {
    const props = renderPill()
    expect(screen.getByRole('button', { name: 'Brief' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'Takeaway' }))
    expect(props.onSelectLevel).toHaveBeenCalledWith('takeaway')
  })

  it('names the agent once on a written level', () => {
    renderPill({ level: 'key' })
    expect(screen.getAllByText('Written by Claude Code')).toHaveLength(1)
  })

  it('lets a level still being written be chosen and says it is writing', async () => {
    const props = renderPill({ layers: layers({ ready: [], status: 'writing' }) })
    expect(screen.getByText('Writing…')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Key' }))
    expect(props.onSelectLevel).toHaveBeenCalledWith('key')
  })

  it('dims the written levels and says why when there is no agent', () => {
    renderPill({ layers: layers({ ready: [], status: 'no_agent', agent: null }) })
    expect(screen.getByText('No agent connected · Settings → AI')).toBeInTheDocument()
    for (const name of ['Key', 'Takeaway', 'Topic']) {
      expect(screen.getByRole('button', { name })).toBeDisabled()
    }
    expect(screen.getByRole('button', { name: 'Full' })).toBeEnabled()
  })

  it('copies the folded view and says so', async () => {
    const props = renderPill()
    await userEvent.click(screen.getByRole('button', { name: 'Copy as text' }))
    expect(props.onCopy).toHaveBeenCalledOnce()
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('offers a retry after a failed run', async () => {
    const props = renderPill({ layers: layers({ ready: [], status: 'failed' }) })
    await userEvent.click(screen.getByRole('button', { name: 'Last run failed · Retry' }))
    expect(props.onRetry).toHaveBeenCalledOnce()
  })
})
