import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NoteNamesLine } from './note-names-line'
import { requestNoteNameInput } from './note-name-input-request'

const mocks = vi.hoisted(() => ({
  editAliases: vi.fn(),
  resolveByTitle: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/services/notes-service', () => ({
  notesService: {
    editAliases: (...args: unknown[]) => mocks.editAliases(...args),
    resolveByTitle: (...args: unknown[]) => mocks.resolveByTitle(...args)
  }
}))

vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => mocks.toastError(...args) } }))

function renderLine(aliases: string[]) {
  return render(
    <NoteNamesLine noteId="note-ai" title="Artificial Intelligence" aliases={aliases} />
  )
}

async function openAddInput(): Promise<HTMLElement> {
  act(() => {
    requestNoteNameInput('note-ai')
  })
  return screen.findByRole('textbox', { name: 'Another name for this note' })
}

describe('NoteNamesLine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveByTitle.mockResolvedValue(null)
  })

  it('renders nothing for a note without names', () => {
    const { container } = renderLine([])
    expect(container).toBeEmptyDOMElement()
  })

  it('reads "also" followed by the names', () => {
    renderLine(['AI', 'Yapay Zeka'])
    expect(screen.getByTestId('note-names')).toHaveTextContent('also AI · Yapay Zeka')
  })

  it('adds a name on Enter from an empty note', async () => {
    mocks.editAliases.mockResolvedValue({ aliases: ['AGI'] })
    renderLine([])

    await userEvent.type(await openAddInput(), 'AGI{Enter}')

    expect(mocks.editAliases).toHaveBeenCalledWith({ id: 'note-ai', add: ['AGI'], remove: [] })
    expect(screen.getByTestId('note-names')).toHaveTextContent('also AGI')
  })

  it('removes the last name on Backspace in an empty input', async () => {
    mocks.editAliases.mockResolvedValue({ aliases: ['AI'] })
    renderLine(['AI', 'Yapay Zeka'])

    await userEvent.type(await openAddInput(), '{Backspace}')

    expect(mocks.editAliases).toHaveBeenCalledWith({
      id: 'note-ai',
      add: [],
      remove: ['Yapay Zeka']
    })
    expect(screen.getByTestId('note-names')).toHaveTextContent('also AI')
  })

  it('renames a clicked name, and cancels on Escape', async () => {
    mocks.editAliases.mockResolvedValue({ aliases: ['A.I.'] })
    renderLine(['AI'])

    await userEvent.click(screen.getByRole('button', { name: 'Edit or remove the name AI' }))
    await userEvent.keyboard('{Escape}')
    expect(mocks.editAliases).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Edit or remove the name AI' }))
    await userEvent.keyboard('{Control>}a{/Control}A.I.{Enter}')
    expect(mocks.editAliases).toHaveBeenCalledWith({ id: 'note-ai', add: ['A.I.'], remove: ['AI'] })
  })

  it('puts the names back and says so when saving fails', async () => {
    mocks.editAliases.mockRejectedValue(new Error('disk full'))
    renderLine(['AI'])

    await userEvent.type(await openAddInput(), 'AGI{Enter}')

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalled()
    })
    expect(screen.getByTestId('note-names')).toHaveTextContent(/^also AI$/)
  })

  it('warns before saving a name another note already answers to, and still saves', async () => {
    mocks.resolveByTitle.mockResolvedValue({
      id: 'note-ml',
      path: 'Machine learning.md',
      title: 'Machine learning',
      fileType: 'markdown'
    })
    mocks.editAliases.mockResolvedValue({ aliases: ['AI', 'Machine learning'] })
    renderLine(['AI'])

    const input = await openAddInput()
    await userEvent.type(input, 'machine learning')

    expect(await screen.findByRole('status')).toHaveTextContent(
      '“machine learning” is already a note. Links to it will keep opening Machine learning.'
    )
    await userEvent.type(input, '{Enter}')
    expect(mocks.editAliases).toHaveBeenCalledWith({
      id: 'note-ai',
      add: ['machine learning'],
      remove: []
    })
  })
})
