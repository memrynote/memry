import { createRef } from 'react'

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/core'
import { Schema } from '@tiptap/pm/model'
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state'

import { AgentPromptEditor, type AgentPromptEditorHandle } from '@/agent-chat/agent-prompt-editor'
import {
  CommentFormatButtons,
  CommentFormatToolbar,
  COMMENT_FORMAT_ITEMS,
  shouldShowCommentFormatToolbar
} from './comment-format-toolbar'

// The live editor instance is only handed to the render prop, so capture it there.
let capturedEditor: Editor | null = null
function editorForHandle(): Editor {
  if (!capturedEditor) throw new Error('editor not mounted')
  return capturedEditor
}

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key, i18n: { language: 'en' } })
}))

// Mirrors the shape that matters here: inline text plus a selectable atom, the
// way `agentMention` behaves in the real composer.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    mention: {
      group: 'inline',
      inline: true,
      atom: true,
      selectable: true,
      toDOM: () => ['span', '@label']
    },
    text: { group: 'inline' }
  }
})

function stateWith(text: string, select: (doc: ReturnType<typeof buildDoc>) => unknown) {
  const doc = buildDoc(text)
  return EditorState.create({ doc, selection: select(doc) as never })
}

function buildDoc(text: string) {
  return schema.node('doc', null, [
    schema.node('paragraph', null, [...(text ? [schema.text(text)] : []), schema.node('mention')])
  ])
}

const baseArgs = { isEditable: true, element: null, suppressed: false, hasFocus: true }

describe('shouldShowCommentFormatToolbar', () => {
  it('shows for a focused, non-empty text selection', () => {
    const state = stateWith('hello there', (doc) => TextSelection.create(doc, 1, 6))
    expect(shouldShowCommentFormatToolbar({ ...baseArgs, state })).toBe(true)
  })

  it('hides for an empty selection', () => {
    const state = stateWith('hello there', (doc) => TextSelection.create(doc, 3, 3))
    expect(shouldShowCommentFormatToolbar({ ...baseArgs, state })).toBe(false)
  })

  it('hides while the mention picker owns the selection', () => {
    const state = stateWith('hello there', (doc) => TextSelection.create(doc, 1, 6))
    expect(shouldShowCommentFormatToolbar({ ...baseArgs, state, suppressed: true })).toBe(false)
  })

  it('hides when the editor is not editable', () => {
    const state = stateWith('hello there', (doc) => TextSelection.create(doc, 1, 6))
    expect(shouldShowCommentFormatToolbar({ ...baseArgs, state, isEditable: false })).toBe(false)
  })

  it('hides for a whitespace-only range', () => {
    const state = stateWith('    ', (doc) => TextSelection.create(doc, 1, 5))
    expect(shouldShowCommentFormatToolbar({ ...baseArgs, state })).toBe(false)
  })

  it('hides when an @mention chip is node-selected', () => {
    const doc = buildDoc('hello ')
    const state = EditorState.create({ doc, selection: NodeSelection.create(doc, 7) })
    expect(state.selection).toBeInstanceOf(NodeSelection)
    expect(shouldShowCommentFormatToolbar({ ...baseArgs, state })).toBe(false)
  })

  it('stays open while focus sits inside the toolbar itself', () => {
    const state = stateWith('hello there', (doc) => TextSelection.create(doc, 1, 6))
    const element = document.createElement('div')
    const button = document.createElement('button')
    element.appendChild(button)
    document.body.appendChild(element)
    button.focus()

    expect(shouldShowCommentFormatToolbar({ ...baseArgs, state, element, hasFocus: false })).toBe(
      true
    )
    element.remove()
  })
})

describe('CommentFormatButtons', () => {
  function fakeEditor(activeMark: string | null) {
    const run = vi.fn()
    const chain = {
      focus: () => chain,
      toggleBold: () => chain,
      toggleItalic: () => chain,
      toggleUnderline: () => chain,
      toggleStrike: () => chain,
      toggleCode: () => chain,
      run
    }
    return {
      editor: {
        isActive: (mark: string) => mark === activeMark,
        chain: () => chain
      } as unknown as Editor,
      run
    }
  }

  it('renders every mark button and runs its command on click', () => {
    const { editor, run } = fakeEditor(null)
    render(<CommentFormatButtons editor={editor} />)

    for (const item of COMMENT_FORMAT_ITEMS) {
      const button = screen.getByLabelText(item.labelKey)
      expect(button).toHaveAttribute('aria-pressed', 'false')
      fireEvent.click(button)
    }
    expect(run).toHaveBeenCalledTimes(COMMENT_FORMAT_ITEMS.length)
  })

  it('marks the active mark as pressed', () => {
    const { editor } = fakeEditor('bold')
    render(<CommentFormatButtons editor={editor} />)

    expect(screen.getByLabelText('comments.format.bold')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('comments.format.italic')).toHaveAttribute('aria-pressed', 'false')
  })

  it('swallows pointer events so the text selection survives the click', () => {
    const { editor } = fakeEditor(null)
    const { container } = render(<CommentFormatButtons editor={editor} />)
    const row = container.querySelector('.critic-comment-format-row') as HTMLElement

    expect(fireEvent.mouseDown(row)).toBe(false)
    expect(fireEvent.pointerDown(row)).toBe(false)
  })
})

describe('CommentFormatToolbar mounted on a real editor', () => {
  it('portals a tagged toolbar to the body for a live text selection', async () => {
    // jsdom has no layout; floating-ui needs rects to place the bubble.
    const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 20, right: 60, width: 60, height: 20 }
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(rect as DOMRect)
    // ProseMirror's coordsAtPos indexes into the list, so it must be array-like.
    const rectList = Object.assign([rect], { item: () => rect })
    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue(rectList as unknown as DOMRectList)
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    )

    const ref = createRef<AgentPromptEditorHandle>()
    render(
      <AgentPromptEditor
        ref={ref}
        disabled={false}
        placeholder="Add a comment..."
        richTextMarks
        renderSelectionToolbar={(editor) => {
          capturedEditor = editor
          return <CommentFormatToolbar editor={editor} suppressed={false} />
        }}
        onEscape={vi.fn()}
        onMentionKeyDown={vi.fn(() => false)}
        onMentionQueryChange={vi.fn()}
        onSubmit={vi.fn()}
        onValueChange={vi.fn()}
      />
    )

    act(() => ref.current?.seed([{ kind: 'text', text: 'needs a source' }]))
    act(() => {
      ref.current?.focus()
      // ProseMirror doc positions run one ahead of the flattened text offsets.
      editorForHandle().commands.setTextSelection({ from: 9, to: 15 })
    })

    await waitFor(() => {
      expect(document.querySelector('body > [data-comment-format-toolbar]')).not.toBeNull()
    })

    // The command reaches the real schema: the mark set is genuinely enabled.
    act(() => {
      editorForHandle().chain().focus().toggleBold().run()
    })
    const value = ref.current?.getValue()
    expect(value?.formatRanges).toEqual([{ start: 8, end: 14, marks: ['bold'] }])
    expect(value?.text.slice(8, 14)).toBe('source')

    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })
})
