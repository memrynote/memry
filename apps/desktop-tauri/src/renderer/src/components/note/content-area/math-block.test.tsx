/**
 * The math block's editing surface (#1871).
 *
 * The bytes are gated elsewhere — the conformance corpus asserts `$$…$$`
 * through both pipelines. What is only true here is the popup's contract: the
 * source box is the draft, and the BLOCK is written once, when the box closes.
 * A version that wrote on every keystroke re-rendered the node view under an
 * open popover and took the caret out of the textarea with it.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) ?? key })
}))

import { MathBlockRenderer, getMathSlashMenuItem } from './math-block'

function editorDouble() {
  const block = { props: { latex: '' } }
  return {
    block,
    getTextCursorPosition: () => ({ block }),
    updateBlock: vi.fn()
  }
}

describe('MathBlockRenderer', () => {
  it('renders the formula rather than its source', () => {
    // #given a block holding valid LaTeX
    const editor = editorDouble()

    // #when
    const { container } = render(
      <MathBlockRenderer block={{ props: { latex: 'E = mc^2' } }} editor={editor} />
    )

    // #then KaTeX typeset it, and the accessible form is MathML rather than
    // the `^` the author typed
    expect(container.querySelector('.katex')).not.toBeNull()
    expect(container.querySelector('math')).not.toBeNull()
  })

  it('shows the parse error for LaTeX it cannot render', () => {
    // #given a control sequence KaTeX does not know. Its own fallback prints
    // the source in red, which reads as a rendered formula that is merely
    // coloured — so the block presents the failure itself.
    const editor = editorDouble()

    // #when
    const { container } = render(
      <MathBlockRenderer block={{ props: { latex: '\\fracc{1}{2}' } }} editor={editor} />
    )

    // #then
    expect(container.querySelector('.katex')).toBeNull()
    expect(screen.getByText(/Undefined control sequence/)).toBeInTheDocument()
  })

  it('offers the empty prompt when there is no source yet', () => {
    render(<MathBlockRenderer block={{ props: { latex: '' } }} editor={editorDouble()} />)

    expect(screen.getByRole('button')).toHaveAttribute('data-math-empty', 'true')
  })

  it('writes the block once, when the source box closes', async () => {
    // #given an open source box
    const user = userEvent.setup()
    const editor = editorDouble()
    render(<MathBlockRenderer block={{ props: { latex: '' } }} editor={editor} />)
    await user.click(screen.getByRole('button'))

    // #when the author types a formula
    await user.type(screen.getByRole('textbox'), 'a^2')

    // #then nothing is written yet — a prop write here re-renders the node view
    // and takes the caret out of the box
    expect(editor.updateBlock).not.toHaveBeenCalled()

    // #when the box closes
    await user.keyboard('{Escape}')

    // #then the draft lands on the block, once
    expect(editor.updateBlock).toHaveBeenCalledTimes(1)
    expect(editor.updateBlock).toHaveBeenCalledWith(expect.anything(), {
      type: 'mathBlock',
      props: { latex: 'a^2' }
    })
  })

  it('writes nothing when the source box closes unchanged', async () => {
    const user = userEvent.setup()
    const editor = editorDouble()
    render(<MathBlockRenderer block={{ props: { latex: 'E = mc^2' } }} editor={editor} />)

    await user.click(screen.getByRole('button'))
    await user.keyboard('{Escape}')

    // #then an open-and-close is not an edit, so the note is not dirtied
    expect(editor.updateBlock).not.toHaveBeenCalled()
  })
})

describe('getMathSlashMenuItem', () => {
  it('turns the block at the cursor into an empty equation', () => {
    // #given
    const editor = editorDouble()
    const item = getMathSlashMenuItem(editor, { title: 'Equation', group: 'g', subtext: 's' })

    // #when
    item.onItemClick()

    // #then the block is created empty; the source box is where it is filled in
    expect(editor.updateBlock).toHaveBeenCalledWith(editor.block, {
      type: 'mathBlock',
      props: { latex: '' }
    })
  })

  it('is reachable by the words people type for it', () => {
    const item = getMathSlashMenuItem(editorDouble(), { title: 'T', group: 'g', subtext: 's' })

    expect(item.aliases).toEqual(expect.arrayContaining(['math', 'equation', 'latex', 'formula']))
  })
})
