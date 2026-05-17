import { createRef, type RefObject } from 'react'

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { AgentPromptEditor, type AgentPromptEditorHandle } from '../agent-prompt-editor'
import type { MentionAttachment } from '../mention-icons'

function renderPromptEditor() {
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
    expect(ref.current?.getValue()).toEqual({ text: '', attachments: [] })

    await typePrompt('hello')
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onEscape).toHaveBeenCalledTimes(1)

    act(() => {
      ref.current?.clear()
    })

    expect(ref.current?.getValue()).toEqual({ text: '', attachments: [] })
    expect(onValueChange).toHaveBeenLastCalledWith({ text: '', attachments: [] })
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
      ]
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
})
