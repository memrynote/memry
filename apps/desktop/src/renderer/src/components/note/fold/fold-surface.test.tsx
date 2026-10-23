import { useEffect, useRef, useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FoldLayers } from '@memry/contracts/note-fold'
import { layers } from './fold-fixtures'
import { FoldLevelControl } from './fold-level-control'
import { FoldSurface } from './fold-surface'
import { useNoteFold } from './use-note-fold'
import { useEditorTarget, type EditorHandle } from '@/commands/editor-target'

function Host({ wordCount = 1104 }: { wordCount?: number }) {
  const fold = useNoteFold('note-1', wordCount)
  return (
    <>
      {fold.control && <FoldLevelControl {...fold.control} />}
      <FoldSurface fold={fold}>
        <div data-testid="editor" contentEditable suppressContentEditableWarning>
          the editor
        </div>
      </FoldSurface>
    </>
  )
}

function serve(snapshot: FoldLayers): void {
  vi.mocked(window.api.noteFold.get).mockResolvedValue(snapshot)
}

async function chooseLevel(name: RegExp): Promise<void> {
  await userEvent.click(await screen.findByRole('button', { name: 'Fold level' }))
  await userEvent.click(screen.getByRole('menuitemradio', { name }))
}

function TypingHost({ editor }: { editor: EditorHandle }) {
  const fold = useNoteFold('note-1', 1104)
  const node = useRef<HTMLDivElement>(null)
  const [handle, setHandle] = useState<EditorHandle | null>(null)
  useEffect(() => {
    setHandle({ ...editor, domElement: node.current ?? undefined })
  }, [editor])
  useEditorTarget(handle)
  return (
    <>
      {fold.control && <FoldLevelControl {...fold.control} />}
      <FoldSurface fold={fold}>
        <div ref={node}>
          <div className="ProseMirror" contentEditable suppressContentEditableWarning>
            <div className="bn-block" data-id="b1">
              <div className="bn-block-content">Where we are</div>
            </div>
            <div className="bn-block" data-id="b2">
              <div className="bn-block-content">
                First sentence here. Second sentence here. Third sentence here.
              </div>
            </div>
            <div className="bn-block" data-id="b3">
              <div className="bn-block-content">Next steps are the changelog and the email.</div>
            </div>
          </div>
        </div>
      </FoldSurface>
    </>
  )
}

function fakeEditor(): EditorHandle & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    setTextCursorPosition: (block, placement) => calls.push(`cursor:${block}:${placement}`),
    insertInlineContent: (content) => calls.push(`insert:${content.join('')}`),
    toggleStyles: () => {},
    getTextCursorPosition: () => undefined,
    updateBlock: () => {},
    insertBlocks: () => {},
    undo: () => true,
    redo: () => true,
    focus: () => {}
  }
}

describe('FoldSurface', () => {
  beforeEach(() => {
    vi.mocked(window.api.noteFold.get).mockReset()
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('shows no level control for a note too short to fold', async () => {
    serve(layers({ status: 'short', totalWords: 90 }))
    render(<Host wordCount={90} />)
    await waitFor(() => expect(window.api.noteFold.get).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: 'Fold level' })).toBeNull()
    expect(screen.queryByTestId('note-fold-overlay')).toBeNull()
  })

  it('opens at Full: the editor shows and no overlay covers it', async () => {
    serve(layers())
    render(<Host />)
    await screen.findByRole('button', { name: 'Fold level' })
    expect(screen.getByTestId('editor')).toBeVisible()
    expect(screen.queryByTestId('note-fold-overlay')).toBeNull()
  })

  it('folds over the editor without unmounting it, and Esc returns to Full', async () => {
    serve(layers())
    render(<Host />)
    await chooseLevel(/^Brief/)

    expect(await screen.findByTestId('note-fold-overlay')).toBeInTheDocument()
    expect(screen.getByTestId('note-word-count')).toHaveTextContent('Brief · 212 words')
    // The same editor node: folding never touches the document or its view.
    expect(screen.getByTestId('editor')).toBeInTheDocument()

    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('note-fold-overlay')).toBeNull())
    expect(screen.getByTestId('editor')).toBeVisible()
  })

  it('Esc closes an opened paragraph before it leaves the fold', async () => {
    serve(layers())
    render(<Host />)
    await chooseLevel(/^Takeaway/)
    await userEvent.click(await screen.findByText('Pro stays at $8'))
    expect(screen.getByText('Opened to Full · click again to fold')).toBeInTheDocument()

    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByText('Opened to Full · click again to fold')).toBeNull()
    )
    expect(screen.getByTestId('note-fold-overlay')).toBeInTheDocument()
  })

  it('returns to Full when the reader starts typing over the fold', async () => {
    serve(layers())
    render(<Host />)
    await chooseLevel(/^Brief/)
    const overlay = await screen.findByTestId('note-fold-overlay')

    fireEvent.keyDown(overlay, { key: 'a' })
    await waitFor(() => expect(screen.queryByTestId('note-fold-overlay')).toBeNull())
  })

  it('shows Brief for a level still being written, then switches when it arrives', async () => {
    serve(layers({ ready: [], status: 'writing' }))
    let notify: (event: { noteId: string }) => void = () => {}
    vi.mocked(window.api.noteFold.onUpdated).mockImplementation((callback) => {
      notify = callback
      return () => {}
    })
    render(<Host />)
    await chooseLevel(/^Key/)
    expect(await screen.findByTestId('note-fold-body')).toHaveAttribute('data-fold-level', 'brief')

    serve(layers())
    notify({ noteId: 'note-1' })
    await waitFor(() =>
      expect(screen.getByTestId('note-fold-body')).toHaveAttribute('data-fold-level', 'key')
    )
  })

  it('steps one level per ctrl+scroll gesture and leaves plain scrolling alone', async () => {
    serve(layers())
    render(<Host />)
    await screen.findByRole('button', { name: 'Fold level' })
    const editor = screen.getByTestId('editor')

    expect(fireEvent.wheel(editor, { deltaY: 100 })).toBe(true)
    expect(screen.queryByTestId('note-fold-overlay')).toBeNull()

    // Page zoom from a pinch is cancelled inside the note area.
    expect(fireEvent.wheel(editor, { deltaY: 100, ctrlKey: true })).toBe(false)
    expect(await screen.findByTestId('note-fold-body')).toHaveAttribute('data-fold-level', 'brief')
  })

  it('closes the level menu when a shortcut or wheel changes the level', async () => {
    serve(layers())
    render(<Host />)
    await userEvent.click(await screen.findByRole('button', { name: 'Fold level' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.wheel(screen.getByTestId('editor'), { deltaY: 100, ctrlKey: true })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })

  it('types the first character at the first paragraph on screen when none was touched', async () => {
    serve(layers())
    const editor = fakeEditor()
    render(<TypingHost editor={editor} />)
    await chooseLevel(/^Brief/)
    const overlay = await screen.findByTestId('note-fold-overlay')
    // p1 is scrolled past; p2 is the first line in view.
    const onScreen = (hash: string, top: number): void => {
      const line = overlay.querySelector(`[data-fold-paragraph="${hash}"]`) as HTMLElement
      line.getBoundingClientRect = () => ({ top, bottom: top + 28 }) as DOMRect
    }
    onScreen('p1', -100)
    onScreen('p2', 40)
    onScreen('p3', 90)

    fireEvent.keyDown(overlay, { key: 'x' })
    await waitFor(() => expect(editor.calls).toEqual(['cursor:b2:end', 'insert:x']))
  })

  it("types the character at the note's end rather than losing it when nothing is in view", async () => {
    serve(layers())
    const editor = fakeEditor()
    render(<TypingHost editor={editor} />)
    await chooseLevel(/^Brief/)
    fireEvent.keyDown(await screen.findByTestId('note-fold-overlay'), { key: 'y' })
    await waitFor(() => expect(editor.calls).toEqual(['cursor:b3:end', 'insert:y']))
  })

  it('types at the paragraph the reader last opened', async () => {
    serve(layers())
    const editor = fakeEditor()
    render(<TypingHost editor={editor} />)
    await chooseLevel(/^Takeaway/)
    await userEvent.click(await screen.findByText('Pro stays at $8'))
    fireEvent.keyDown(screen.getByTestId('note-fold-overlay'), { key: 'z' })
    await waitFor(() => expect(editor.calls).toEqual(['cursor:b2:end', 'insert:z']))
  })
})
