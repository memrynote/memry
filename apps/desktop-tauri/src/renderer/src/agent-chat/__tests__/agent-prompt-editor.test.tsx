import { createRef, type RefObject } from 'react'

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import {
  AgentPromptEditor,
  buildPromptExtensions,
  type AgentPromptEditorHandle
} from '../agent-prompt-editor'
import type { MentionAttachment } from '../mention-icons'

function renderPromptEditor(richTextMarks = false) {
  const ref = createRef<AgentPromptEditorHandle>()
  const onEscape = vi.fn()
  const onMentionKeyDown = vi.fn(() => false)
  const onMentionQueryChange = vi.fn()
  const onSubmit = vi.fn()
  const onValueChange = vi.fn()

  render(
    <AgentPromptEditor
      ref={ref}
      disabled={false}
      placeholder="Ask memrynote anything. @ to use mention file"
      richTextMarks={richTextMarks}
      onEscape={onEscape}
      onMentionKeyDown={onMentionKeyDown}
      onMentionQueryChange={onMentionQueryChange}
      onSubmit={onSubmit}
      onValueChange={onValueChange}
    />
  )

  return { ref, onEscape, onMentionQueryChange, onSubmit, onValueChange }
}

async function typePrompt(text: string): Promise<void> {
  const textbox = screen.getByRole('textbox')
  await userEvent.click(textbox)
  await userEvent.type(textbox, text)
}

function insertMention(ref: RefObject<AgentPromptEditorHandle | null>, mention: MentionAttachment) {
  act(() => {
    ref.current?.insertMention(mention)
  })
}

describe('AgentPromptEditor', () => {
  it('handles keyboard submit, escape, clear, and insert-without-query guard', async () => {
    const { ref, onEscape, onSubmit, onValueChange } = renderPromptEditor()

    insertMention(ref, {
      kind: 'folder',
      ref_id: 'folder-1',
      label: 'Folder',
      icon: { kind: 'folder' }
    })
    expect(ref.current?.getValue()).toEqual({ text: '', attachments: [], formatRanges: [] })

    await typePrompt('hello')
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onEscape).toHaveBeenCalledTimes(1)

    act(() => {
      ref.current?.clear()
    })

    expect(ref.current?.getValue()).toEqual({ text: '', attachments: [], formatRanges: [] })
    expect(onValueChange).toHaveBeenLastCalledWith({ text: '', attachments: [], formatRanges: [] })
  })

  it('inserts plain text through the imperative handle', async () => {
    const { ref, onMentionQueryChange } = renderPromptEditor()

    act(() => {
      ref.current?.insertText('@')
    })

    expect(ref.current?.getValue()).toEqual({ text: '@', attachments: [], formatRanges: [] })
    expect(onMentionQueryChange).toHaveBeenLastCalledWith('')
  })

  it('opens the mention query from the "@" trigger even after a word', async () => {
    const { ref, onMentionQueryChange } = renderPromptEditor()

    await typePrompt('hello')
    act(() => {
      ref.current?.insertMentionTrigger()
    })

    // A leading space is prepended so the mention regex matches after a word.
    expect(ref.current?.getValue()).toEqual({ text: 'hello @', attachments: [], formatRanges: [] })
    expect(onMentionQueryChange).toHaveBeenLastCalledWith('')
  })

  it('inserts a bare "@" from the trigger at the start of an empty editor', () => {
    const { ref, onMentionQueryChange } = renderPromptEditor()

    act(() => {
      ref.current?.insertMentionTrigger()
    })

    expect(ref.current?.getValue()).toEqual({ text: '@', attachments: [], formatRanges: [] })
    expect(onMentionQueryChange).toHaveBeenLastCalledWith('')
  })

  it('serializes non-standard mention kinds and dedupes repeated attachments', async () => {
    const { ref, onMentionQueryChange } = renderPromptEditor()

    await typePrompt('@current')
    insertMention(ref, {
      kind: 'current_note',
      ref_id: 'note-1',
      label: 'Current Note',
      icon: { kind: 'current_note' }
    })
    await typePrompt('@folder')
    insertMention(ref, {
      kind: 'folder',
      ref_id: 'folder-1',
      label: 'Reference Folder',
      icon: { kind: 'folder' }
    })
    await typePrompt('@project')
    insertMention(ref, {
      kind: 'project',
      ref_id: 'project-1',
      label: 'Reference Project',
      icon: { kind: 'project' }
    })
    await typePrompt('@folder-again')
    insertMention(ref, {
      kind: 'folder',
      ref_id: 'folder-1',
      label: 'Reference Folder',
      icon: { kind: 'folder' }
    })

    await waitFor(() => {
      expect(screen.getByTestId('agent-mention-current_note-note-1')).toBeInTheDocument()
      expect(screen.getAllByTestId('agent-mention-folder-folder-1')).toHaveLength(2)
      expect(screen.getByTestId('agent-mention-project-project-1')).toBeInTheDocument()
    })

    expect(ref.current?.getValue()).toEqual({
      text: '@Current Note @Reference Folder @Reference Project @Reference Folder ',
      attachments: [
        { kind: 'current_note', ref_id: 'note-1', label: 'Current Note' },
        { kind: 'folder', ref_id: 'folder-1', label: 'Reference Folder' },
        { kind: 'project', ref_id: 'project-1', label: 'Reference Project' }
      ],
      formatRanges: []
    })
    expect(onMentionQueryChange).toHaveBeenLastCalledWith(null)
  })

  it('selects mention nodes on mouse down and deletes mention atoms with Delete', async () => {
    const { ref } = renderPromptEditor()

    await typePrompt('@task')
    insertMention(ref, {
      kind: 'task',
      ref_id: 'task-1',
      label: 'Task Mention',
      icon: { kind: 'task' }
    })

    const mention = await screen.findByTestId('agent-mention-task-task-1')
    fireEvent.mouseDown(mention)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Delete' })

    await waitFor(() => {
      expect(screen.queryByTestId('agent-mention-task-task-1')).not.toBeInTheDocument()
    })
    expect(ref.current?.getValue().attachments).toEqual([])
  })

  it('keeps every inline mark disabled unless rich text is opted into', () => {
    const starterKitOptions = (richTextMarks: boolean): Record<string, unknown> =>
      (
        buildPromptExtensions(richTextMarks, '')[0] as unknown as {
          options: Record<string, unknown>
        }
      ).options
    const plainStarterKit = { options: starterKitOptions(false) }
    const richStarterKit = { options: starterKitOptions(true) }

    for (const mark of ['bold', 'italic', 'underline', 'strike', 'code']) {
      expect(plainStarterKit.options[mark]).toBe(false)
      expect(richStarterKit.options[mark]).not.toBe(false)
    }
    // Block-level nodes stay off in both: a comment is one paragraph.
    for (const block of ['heading', 'bulletList', 'codeBlock', 'link']) {
      expect(richStarterKit.options[block]).toBe(false)
    }
  })

  it('reports formatting as offsets into the flattened text, mentions kept whole', () => {
    const { ref } = renderPromptEditor(true)

    act(() => {
      ref.current?.seed([
        { kind: 'text', text: 'see ' },
        { kind: 'text', text: 'this', marks: ['bold', 'code'] },
        { kind: 'text', text: ' and ' },
        {
          kind: 'mention',
          attachment: {
            kind: 'note',
            ref_id: 'note-1',
            label: 'Planning',
            icon: { kind: 'note', emoji: null }
          },
          marks: ['italic']
        },
        { kind: 'text', text: '\nnext line', marks: ['strikethrough'] }
      ])
    })

    const value = ref.current?.getValue()
    expect(value?.text).toBe('see this and @Planning\nnext line')
    expect(value?.formatRanges).toEqual([
      { start: 4, end: 8, marks: ['bold', 'code'] },
      { start: 13, end: 22, marks: ['italic'] },
      // Never coalesced across the block separator.
      { start: 23, end: 32, marks: ['strikethrough'] }
    ])
  })

  it('round-trips a seeded value through getValue unchanged', () => {
    const { ref } = renderPromptEditor(true)
    const parts = [
      { kind: 'text' as const, text: 'alpha ' },
      { kind: 'text' as const, text: 'beta', marks: ['bold' as const] },
      { kind: 'text' as const, text: ' gamma' }
    ]

    act(() => ref.current?.seed(parts))
    const first = ref.current?.getValue()

    act(() => ref.current?.seed(parts))
    expect(ref.current?.getValue()).toEqual(first)
  })
})
