import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useReducer } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { FoldLevel } from '@memry/contracts/note-fold'
import { buildFoldedView } from './fold-display'
import { layers, paragraph } from './fold-fixtures'
import { FoldLevelControl } from './fold-level-control'
import { FoldBody } from './fold-overlay'
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

  it('shows the source paragraph under a written line, underlining the sentences it rests on', () => {
    render(<Folded level="takeaway" />)
    const line = screen.getByRole('button', {
      name: /open/i,
      description: /Written from these sentences/
    })
    expect(line).toHaveTextContent('The team plan barely sold')

    const note = screen.getAllByRole('note')[0]
    expect(note).toHaveTextContent(
      'First sentence here. Second sentence here. Third sentence here.'
    )
    // p1 rests on sentence 1 only.
    expect(screen.getByText('Second sentence here.', { selector: 'span' })).toHaveClass('underline')
    expect(screen.getByText('First sentence here.', { selector: 'span' })).not.toHaveClass(
      'underline'
    )
  })

  it("offers no evidence for the author's own words", () => {
    render(<Folded level="brief" />)
    expect(screen.queryByRole('note')).toBeNull()
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
  function renderControl(overrides: Partial<Parameters<typeof FoldLevelControl>[0]> = {}) {
    const props = {
      layers: layers(),
      requested: 'full' as FoldLevel,
      level: 'full' as FoldLevel,
      onSelectLevel: vi.fn(),
      onRetry: vi.fn(),
      ...overrides
    }
    render(<FoldLevelControl {...props} />)
    return props
  }

  it('reads as the word count at Full', () => {
    renderControl()
    expect(screen.getByTestId('note-word-count')).toHaveTextContent('1,104 words')
  })

  it('names the level and its count when folded', () => {
    renderControl({ requested: 'brief', level: 'brief' })
    expect(screen.getByTestId('note-word-count')).toHaveTextContent('Brief · 212 words')
  })

  it('lists the levels with their counts and names the agent once', async () => {
    renderControl()
    await userEvent.click(screen.getByRole('button', { name: 'Fold level' }))
    expect(screen.getByRole('menuitemradio', { name: /Takeaway/ })).toHaveTextContent('46')
    expect(screen.getAllByText('Written by Claude Code')).toHaveLength(1)
  })

  it('greys a level still being written and lets it be chosen', async () => {
    const props = renderControl({ layers: layers({ ready: [], status: 'writing' }) })
    await userEvent.click(screen.getByRole('button', { name: 'Fold level' }))
    const key = screen.getByRole('menuitemradio', { name: /^Key/ })
    expect(key).toHaveTextContent('Writing…')
    await userEvent.click(key)
    expect(props.onSelectLevel).toHaveBeenCalledWith('key')
  })

  it('offers only Full and Brief when there is no agent', async () => {
    renderControl({ layers: layers({ ready: [], status: 'no_agent', agent: null }) })
    await userEvent.click(screen.getByRole('button', { name: 'Fold level' }))
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(2)
  })

  it('offers a retry after a failed run', async () => {
    const props = renderControl({ layers: layers({ ready: [], status: 'failed' }) })
    await userEvent.click(screen.getByRole('button', { name: 'Fold level' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Last run failed · Retry' }))
    expect(props.onRetry).toHaveBeenCalledOnce()
  })
})
