import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CodeBlockToolbar } from './code-block-toolbar'

const editor = {
  isEditable: true,
  getBlock: vi.fn(() => ({ type: 'codeBlock', props: { language: 'powershell' } })),
  updateBlock: vi.fn(),
  getTextCursorPosition: vi.fn(() => ({ block: { type: 'paragraph', id: 'p1' } }))
}

vi.mock('@blocknote/react', () => ({
  useBlockNoteEditor: () => editor,
  useEditorSelectionChange: () => undefined
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) ?? key })
}))

const writeText = vi.fn<(text: string) => Promise<void>>()

function makeEditor(code = 'Get-ChildItem') {
  const container = document.createElement('div')
  const block = document.createElement('div')
  block.dataset.contentType = 'codeBlock'
  block.dataset.id = 'code-1'
  block.getBoundingClientRect = vi.fn(
    () => ({ top: 100, left: 40, right: 440, bottom: 200 }) as DOMRect
  )
  const pre = document.createElement('pre')
  pre.textContent = code
  block.appendChild(pre)
  container.appendChild(block)
  document.body.appendChild(container)
  return { container, block, pre }
}

describe('CodeBlockToolbar', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    writeText.mockReset().mockResolvedValue(undefined)
    editor.updateBlock.mockReset()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    })
  })

  it('shows nothing until the pointer is over a code block', () => {
    // #given
    const { container } = makeEditor()

    // #when
    render(<CodeBlockToolbar containerEl={container} />)

    // #then
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('copies the block’s code, then confirms', async () => {
    // #given
    const { container, pre } = makeEditor('Get-ChildItem')
    render(<CodeBlockToolbar containerEl={container} />)

    // #when
    fireEvent.pointerOver(pre)
    fireEvent.click(screen.getByRole('button', { name: 'copy' }))

    // #then
    expect(writeText).toHaveBeenCalledWith('Get-ChildItem')
    await waitFor(() => expect(screen.getByRole('button', { name: 'copied' })).toBeTruthy())
  })

  it('places itself in the block’s block-start / inline-end corner', () => {
    // #given a 400px-wide block at top 100, right 440.
    const { container, pre } = makeEditor()
    render(<CodeBlockToolbar containerEl={container} />)

    // #when
    fireEvent.pointerOver(pre)

    // #then 8px in from the top, its inline-end edge 8px in from the right.
    const toolbar = screen.getByRole('button').parentElement
    expect(toolbar?.style.top).toBe('108px')
    expect(toolbar?.style.left).toBe('432px')
    expect(toolbar?.style.transform).toBe('translateX(-100%)')
  })

  it('writes the picked language back to the block', () => {
    // #given
    const { container, pre } = makeEditor()
    render(<CodeBlockToolbar containerEl={container} />)
    fireEvent.pointerOver(pre)

    // #when
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'kusto' } })

    // #then
    expect(editor.updateBlock).toHaveBeenCalledWith('code-1', {
      type: 'codeBlock',
      props: { language: 'kusto' }
    })
  })

  it('goes away when the pointer moves to a non-code block', () => {
    // #given
    const { container, pre } = makeEditor()
    const paragraph = document.createElement('p')
    container.appendChild(paragraph)
    render(<CodeBlockToolbar containerEl={container} />)
    fireEvent.pointerOver(pre)
    expect(screen.getByRole('button')).toBeTruthy()

    // #when
    fireEvent.pointerOver(paragraph)

    // #then
    expect(screen.queryByRole('button')).toBeNull()
  })
})
