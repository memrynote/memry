/**
 * CaptureBar tests.
 *
 * CaptureBar is the single capture field behind Inbox, Tasks and the Project
 * hub, so these cover three things: the keyboard contract, the capability
 * matrix (an affordance must not render unless its prop is passed), and the
 * shared geometry — the three surfaces drifting apart is the bug this
 * component exists to prevent.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import type { ReactElement, ReactNode } from 'react'
import { forwardRef, useImperativeHandle } from 'react'
import { createRendererI18n } from '@memry/i18n/renderer'
import { CaptureBar } from './capture-bar'
import type { Project } from '@/data/tasks-data'

// jsdom has no layout engine; the autocomplete dropdown scrolls its selection.
Element.prototype.scrollIntoView = vi.fn()

const mocks = vi.hoisted(() => ({
  recorderStart: vi.fn(),
  listNotes: vi.fn(),
  getAllTagsWithCounts: vi.fn()
}))

// The `[[` picker and the `#` ghost read these pools lazily, the first time the
// user reaches for one.
vi.mock('@/services/notes-service', () => ({
  notesService: { list: mocks.listNotes }
}))

vi.mock('@/services/tags-service', () => ({
  tagsService: { getAllWithCounts: mocks.getAllTagsWithCounts }
}))

vi.mock('@/components/voice-recorder', () => ({
  VoiceRecorder: forwardRef(
    (
      {
        onRecordingComplete,
        onCancel
      }: {
        onRecordingComplete: (blob: Blob, duration: number) => void
        onCancel: () => void
      },
      ref
    ) => {
      useImperativeHandle(ref, () => ({ start: mocks.recorderStart }))
      return (
        <div data-testid="voice-recorder">
          <button
            type="button"
            onClick={() => onRecordingComplete(new Blob(['audio'], { type: 'audio/webm' }), 12)}
          >
            complete voice
          </button>
          <button type="button" onClick={onCancel}>
            cancel voice
          </button>
        </div>
      )
    }
  )
}))

let i18nEn: I18nInstance

beforeAll(async () => {
  i18nEn = await createRendererI18n({ locale: 'en' })
})

function renderBar(ui: ReactElement) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <I18nextProvider i18n={i18nEn}>{children}</I18nextProvider>
  )
  return render(ui, { wrapper: Wrapper })
}

const mockProjects: Project[] = [
  {
    id: 'project-1',
    name: 'Personal',
    isDefault: false,
    isArchived: false,
    position: 0,
    statuses: [],
    color: '#3B82F6',
    icon: 'folder'
  },
  {
    id: 'project-2',
    name: 'Work',
    isDefault: false,
    isArchived: false,
    position: 1,
    statuses: [],
    color: '#22C55E',
    icon: 'folder'
  },
  {
    id: 'inbox',
    name: 'Inbox',
    isDefault: true,
    isArchived: false,
    position: -1,
    statuses: [],
    color: '#6B7280',
    icon: 'inbox'
  }
]

const baseProps = {
  placeholder: 'Capture something…',
  ariaLabel: 'Capture field'
}

const field = (): HTMLTextAreaElement =>
  screen.getByRole('textbox', { name: 'Capture field' }) as HTMLTextAreaElement

/** The un-typed remainder painted after the caret by the inline completion. */
const ghost = (): HTMLElement => screen.getByTestId('capture-bar-ghost')

const mockNotes = [
  { id: 'note-1', title: 'Roadmap' },
  { id: 'note-2', title: 'Q1 Goals' },
  { id: 'note-3', title: 'Hiring plan' }
]

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listNotes.mockResolvedValue({ notes: mockNotes })
  mocks.getAllTagsWithCounts.mockResolvedValue({
    tags: [
      { name: 'launch', count: 9 },
      { name: 'later', count: 2 }
    ]
  })
})

// ============================================================================
// Text entry and submit
// ============================================================================

describe('CaptureBar — text entry', () => {
  it('renders the placeholder and accepts typing', async () => {
    const user = userEvent.setup()
    renderBar(<CaptureBar {...baseProps} onSubmit={vi.fn()} />)

    expect(screen.getByPlaceholderText('Capture something…')).toBeInTheDocument()

    await user.type(field(), 'Buy milk')
    expect(field()).toHaveValue('Buy milk')
  })

  it('submits the trimmed text on Enter and clears the field', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    renderBar(<CaptureBar {...baseProps} onSubmit={onSubmit} />)

    await user.type(field(), '  Buy milk  {enter}')

    expect(onSubmit).toHaveBeenCalledWith('Buy milk')
    await waitFor(() => expect(field()).toHaveValue(''))
  })

  it('keeps the text when onSubmit returns false', async () => {
    const user = userEvent.setup()
    renderBar(<CaptureBar {...baseProps} onSubmit={() => false} />)

    await user.type(field(), 'Duplicate thought{enter}')

    await waitFor(() => expect(field()).toHaveValue('Duplicate thought'))
  })

  it('keeps focus after submitting so entry can continue', async () => {
    const user = userEvent.setup()
    renderBar(<CaptureBar {...baseProps} onSubmit={vi.fn()} />)

    await user.type(field(), 'Buy milk{enter}')

    await waitFor(() => expect(field()).toHaveFocus())
  })

  it('does not submit empty or whitespace-only input', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    renderBar(<CaptureBar {...baseProps} onSubmit={onSubmit} />)

    await user.click(field())
    await user.keyboard('{Enter}')
    await user.type(field(), '   {enter}')

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('inserts a newline on Shift+Enter instead of submitting', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    renderBar(<CaptureBar {...baseProps} onSubmit={onSubmit} />)

    await user.type(field(), 'First line{Shift>}{Enter}{/Shift}second line')

    expect(onSubmit).not.toHaveBeenCalled()
    expect(field()).toHaveValue('First line\nsecond line')
  })

  it('clears the field on Escape', async () => {
    const user = userEvent.setup()
    renderBar(<CaptureBar {...baseProps} onSubmit={vi.fn()} />)

    await user.type(field(), 'Never mind')
    await user.keyboard('{Escape}')

    expect(field()).toHaveValue('')
  })

  it('disables the field and shows a spinner while the surface is busy', () => {
    renderBar(<CaptureBar {...baseProps} onSubmit={vi.fn()} isBusy />)

    expect(field()).toBeDisabled()
  })
})

// ============================================================================
// Focus signals and the `q` shortcut
// ============================================================================

describe('CaptureBar — focus', () => {
  it('focuses the field when the q shortcut fires', async () => {
    const user = userEvent.setup()
    renderBar(<CaptureBar {...baseProps} onSubmit={vi.fn()} />)

    expect(field()).not.toHaveFocus()
    await user.keyboard('q')

    await waitFor(() => expect(field()).toHaveFocus())
  })

  it('focuses the field when focusSignal changes', () => {
    const { rerender } = renderBar(<CaptureBar {...baseProps} onSubmit={vi.fn()} focusSignal={0} />)
    expect(field()).not.toHaveFocus()

    // Bare element: rerender re-applies the wrapper, and wrapping it again here
    // would remount CaptureBar instead of updating the mounted one.
    rerender(<CaptureBar {...baseProps} onSubmit={vi.fn()} focusSignal={1} />)

    expect(field()).toHaveFocus()
  })

  it('empties the field when clearSignal changes', async () => {
    const user = userEvent.setup()
    const { rerender } = renderBar(
      <CaptureBar {...baseProps} onSubmit={() => false} clearSignal={0} />
    )

    await user.type(field(), 'Handled elsewhere{enter}')
    await waitFor(() => expect(field()).toHaveValue('Handled elsewhere'))

    rerender(<CaptureBar {...baseProps} onSubmit={() => false} clearSignal={1} />)

    expect(field()).toHaveValue('')
  })

  it('shows the Q affordance only while unfocused', async () => {
    const user = userEvent.setup()
    renderBar(<CaptureBar {...baseProps} onSubmit={vi.fn()} />)

    expect(screen.getByText('Q')).toBeInTheDocument()

    await user.click(field())
    expect(screen.queryByText('Q')).not.toBeInTheDocument()
  })
})

// ============================================================================
// The global `q` binding — one stable listener, one owner
// ============================================================================

describe('CaptureBar — global q binding', () => {
  const countKeydown = (calls: readonly unknown[][]): number =>
    calls.filter((call) => String(call[0]) === 'keydown').length

  it('binds the window listener once instead of rebinding on every keystroke', async () => {
    const user = userEvent.setup()
    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')

    try {
      renderBar(<CaptureBar {...baseProps} onSubmit={vi.fn()} />)
      expect(countKeydown(addSpy.mock.calls)).toBe(1)

      await user.type(field(), 'Buy milk')

      expect(countKeydown(addSpy.mock.calls)).toBe(1)
      expect(countKeydown(removeSpy.mock.calls)).toBe(0)
    } finally {
      addSpy.mockRestore()
      removeSpy.mockRestore()
    }
  })

  it('removes the window listener on unmount', () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')

    try {
      const { unmount } = renderBar(<CaptureBar {...baseProps} onSubmit={vi.fn()} />)
      unmount()

      expect(countKeydown(addSpy.mock.calls)).toBe(1)
      expect(countKeydown(removeSpy.mock.calls)).toBe(1)
    } finally {
      addSpy.mockRestore()
      removeSpy.mockRestore()
    }
  })

  it('lets only the active pane act on q when split view mounts two bars', async () => {
    const user = userEvent.setup()
    renderBar(
      <>
        <div data-pane-active="true">
          <CaptureBar {...baseProps} ariaLabel="Active pane capture" onSubmit={vi.fn()} />
        </div>
        <div data-pane-active="false">
          <CaptureBar {...baseProps} ariaLabel="Idle pane capture" onSubmit={vi.fn()} />
        </div>
      </>
    )

    const activeField = screen.getByRole('textbox', { name: 'Active pane capture' })
    const idleField = screen.getByRole('textbox', { name: 'Idle pane capture' })
    const activeFocus = vi.spyOn(activeField, 'focus')
    const idleFocus = vi.spyOn(idleField, 'focus')

    await user.keyboard('q')

    // One keypress, one action — and it lands in the pane the user is in.
    expect(activeFocus).toHaveBeenCalledTimes(1)
    expect(idleFocus).not.toHaveBeenCalled()
    expect(activeField).toHaveFocus()
  })

  it('hands the shortcut to the survivor when a pane unmounts', async () => {
    const user = userEvent.setup()
    const Panes = ({ withActivePane }: { withActivePane: boolean }): ReactElement => (
      <>
        {withActivePane && (
          <div data-pane-active="true">
            <CaptureBar {...baseProps} ariaLabel="Active pane capture" onSubmit={vi.fn()} />
          </div>
        )}
        <div data-pane-active="false">
          <CaptureBar {...baseProps} ariaLabel="Idle pane capture" onSubmit={vi.fn()} />
        </div>
      </>
    )

    const { rerender } = renderBar(<Panes withActivePane />)
    rerender(<Panes withActivePane={false} />)

    const survivor = screen.getByRole('textbox', { name: 'Idle pane capture' })
    const survivorFocus = vi.spyOn(survivor, 'focus')

    await user.keyboard('q')

    expect(survivorFocus).toHaveBeenCalledTimes(1)
    expect(survivor).toHaveFocus()
  })
})

// ============================================================================
// Capability matrix — an affordance renders only when its prop is passed
// ============================================================================

describe('CaptureBar — capabilities', () => {
  it('renders no paperclip, mic or detail hint by default', async () => {
    const user = userEvent.setup()
    renderBar(<CaptureBar {...baseProps} onSubmit={vi.fn()} />)

    await user.click(field())

    expect(screen.queryByRole('button', { name: 'Attach files' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Record voice memo' })).not.toBeInTheDocument()
    expect(screen.queryByText('detail')).not.toBeInTheDocument()
  })

  it('renders the paperclip and calls onAttach when attachment is passed', async () => {
    const user = userEvent.setup()
    const onAttach = vi.fn()
    renderBar(
      <CaptureBar
        {...baseProps}
        onSubmit={vi.fn()}
        attachment={{ onAttach, label: 'Attach files' }}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Attach files' }))

    expect(onAttach).toHaveBeenCalledTimes(1)
  })

  it('fires onAttach once for a mouse press even though it also fires on pointerdown', async () => {
    const user = userEvent.setup()
    const onAttach = vi.fn()
    renderBar(
      <CaptureBar
        {...baseProps}
        onSubmit={vi.fn()}
        attachment={{ onAttach, label: 'Attach files' }}
      />
    )

    const button = screen.getByRole('button', { name: 'Attach files' })
    await user.pointer([{ target: button, keys: '[MouseLeft]' }])

    expect(onAttach).toHaveBeenCalledTimes(1)
  })

  it('disables the paperclip while the attachment is busy', () => {
    renderBar(
      <CaptureBar
        {...baseProps}
        onSubmit={vi.fn()}
        attachment={{ onAttach: vi.fn(), label: 'Attach files', busy: true }}
      />
    )

    expect(screen.getByRole('button', { name: 'Attach files' })).toBeDisabled()
  })

  it('renders the mic, gates on onBeforeStart, and starts the recorder', async () => {
    const user = userEvent.setup()
    const onBeforeStart = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    renderBar(
      <CaptureBar
        {...baseProps}
        onSubmit={vi.fn()}
        voice={{ onComplete: vi.fn(), onBeforeStart, label: 'Record voice memo' }}
      />
    )

    const mic = screen.getByRole('button', { name: 'Record voice memo' })

    await user.click(mic)
    expect(mocks.recorderStart).not.toHaveBeenCalled()
    expect(screen.queryByTestId('voice-recorder')).not.toBeInTheDocument()

    await user.click(mic)
    await waitFor(() => expect(mocks.recorderStart).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('voice-recorder')).toBeInTheDocument()
  })

  it('hands the finished recording to the surface', async () => {
    const user = userEvent.setup()
    const onComplete = vi.fn()
    renderBar(
      <CaptureBar
        {...baseProps}
        onSubmit={vi.fn()}
        voice={{ onComplete, label: 'Record voice memo' }}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Record voice memo' }))
    await user.click(screen.getByRole('button', { name: 'complete voice' }))

    expect(onComplete).toHaveBeenCalledWith(expect.any(Blob), 12)
  })

  it('splits the row between the field and the recorder while recording', async () => {
    const user = userEvent.setup()
    renderBar(
      <CaptureBar
        {...baseProps}
        onSubmit={vi.fn()}
        voice={{ onComplete: vi.fn(), label: 'Record voice memo' }}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Record voice memo' }))

    await waitFor(() => {
      expect(screen.getByTestId('capture-bar-shell')).toHaveClass('w-[60%]')
      expect(screen.getByTestId('capture-bar-recorder')).toHaveClass('w-[40%]')
    })
  })

  it('renders the trailing slot and a custom submit label', async () => {
    const user = userEvent.setup()
    renderBar(
      <CaptureBar
        {...baseProps}
        onSubmit={vi.fn()}
        submitLabel={(value) => (value.startsWith('http') ? 'Capture link' : 'Capture note')}
        trailing={<button type="button">Extra</button>}
      />
    )

    expect(screen.getByRole('button', { name: 'Extra' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Capture note' })).toBeDisabled()

    await user.type(field(), 'https://example.com')
    expect(screen.getByRole('button', { name: 'Capture link' })).toBeEnabled()
  })

  it('renders the footer slot', () => {
    renderBar(<CaptureBar {...baseProps} onSubmit={vi.fn()} footer={<p>Already captured</p>} />)

    expect(screen.getByText('Already captured')).toBeInTheDocument()
  })
})

// ============================================================================
// Detail hint (⌘↵)
// ============================================================================

describe('CaptureBar — detail hint', () => {
  it('shows the hint on focus and opens the detail surface on click', async () => {
    const user = userEvent.setup()
    const onOpenDetail = vi.fn()
    renderBar(
      <CaptureBar
        {...baseProps}
        onSubmit={vi.fn()}
        quickAdd={{ projects: mockProjects }}
        onOpenDetail={onOpenDetail}
      />
    )

    await user.type(field(), 'Buy groceries')
    expect(screen.getByText('detail')).toBeInTheDocument()
    expect(screen.getByText('detail').closest('button')).toHaveAttribute('tabindex', '-1')

    await user.click(screen.getByText('detail'))

    expect(onOpenDetail).toHaveBeenCalledWith('Buy groceries')
    expect(field()).toHaveValue('')
  })

  it('opens the detail surface on Cmd+Enter', async () => {
    const user = userEvent.setup()
    const onOpenDetail = vi.fn()
    const onSubmit = vi.fn()
    renderBar(<CaptureBar {...baseProps} onSubmit={onSubmit} onOpenDetail={onOpenDetail} />)

    await user.type(field(), 'Buy groceries')
    await user.keyboard('{Meta>}{Enter}{/Meta}')

    expect(onOpenDetail).toHaveBeenCalledWith('Buy groceries')
    expect(onSubmit).not.toHaveBeenCalled()
    expect(field()).toHaveValue('')
  })
})

// ============================================================================
// Quick-add syntax (opt-in)
// ============================================================================

describe('CaptureBar — quick-add syntax', () => {
  const quickAddProps = {
    ...baseProps,
    quickAdd: { projects: mockProjects }
  }

  it('parses date, priority, project and tags out of the title', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    renderBar(<CaptureBar {...quickAddProps} onSubmit={onSubmit} />)

    await user.type(field(), 'Buy groceries @tomorrow !high +Personal #errands #food')
    await user.keyboard('{Enter}')

    expect(onSubmit).toHaveBeenCalledTimes(1)
    const [title, parsed] = onSubmit.mock.calls[0]
    expect(title).toBe('Buy groceries')
    expect(parsed).toMatchObject({
      priority: 'high',
      projectId: 'project-1',
      tags: ['errands', 'food']
    })
    expect(parsed.dueDate).toBeInstanceOf(Date)
  })

  it('passes no parsed data when quick-add is off', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    renderBar(<CaptureBar {...baseProps} onSubmit={onSubmit} />)

    await user.type(field(), 'Buy groceries @tomorrow{enter}')

    expect(onSubmit).toHaveBeenCalledWith('Buy groceries @tomorrow')
  })

  it('ghosts the completion for !priority, +project and #tag', async () => {
    const user = userEvent.setup()
    renderBar(<CaptureBar {...quickAddProps} onSubmit={vi.fn()} />)

    await user.type(field(), 'Task !hi')
    expect(ghost()).toHaveTextContent('gh')

    await user.clear(field())
    await user.type(field(), 'Task +per')
    expect(ghost()).toHaveTextContent('sonal')

    await user.clear(field())
    await user.type(field(), 'Task #lau')
    await waitFor(() => expect(ghost()).toHaveTextContent('nch'))
  })

  it('completes the token on Tab', async () => {
    const user = userEvent.setup()
    renderBar(<CaptureBar {...quickAddProps} onSubmit={vi.fn()} />)

    await user.type(field(), 'Task +per')
    await user.keyboard('{Tab}')

    expect(field()).toHaveValue('Task +Personal ')
    expect(screen.queryByTestId('capture-bar-ghost')).not.toBeInTheDocument()
  })

  it('completes the token on ArrowRight', async () => {
    const user = userEvent.setup()
    renderBar(<CaptureBar {...quickAddProps} onSubmit={vi.fn()} />)

    await user.type(field(), 'Task !hi')
    await user.keyboard('{ArrowRight}')

    expect(field()).toHaveValue('Task !high ')
  })

  it('detects the trigger on the last line of a multi-line capture', async () => {
    const user = userEvent.setup()
    renderBar(<CaptureBar {...quickAddProps} onSubmit={vi.fn()} />)

    await user.type(field(), 'First line{Shift>}{Enter}{/Shift}+per')

    expect(ghost()).toHaveTextContent('sonal')
  })

  it('submits what is typed on Enter instead of taking the ghost', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    renderBar(<CaptureBar {...quickAddProps} onSubmit={onSubmit} />)

    await user.type(field(), 'Important task !high')
    expect(screen.queryByTestId('capture-bar-ghost')).not.toBeInTheDocument()
    await user.keyboard('{Enter}')

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0]).toBe('Important task')
    expect(onSubmit.mock.calls[0][1]).toMatchObject({ priority: 'high' })
    await waitFor(() => expect(field()).toHaveValue(''))
  })

  it('ghosts nothing for plain prose', async () => {
    const user = userEvent.setup()
    renderBar(<CaptureBar {...quickAddProps} onSubmit={vi.fn()} />)

    await user.type(field(), 'Buy groceries')

    expect(screen.queryByTestId('capture-bar-ghost')).not.toBeInTheDocument()
  })

  it('ghosts nothing when quick-add is off', async () => {
    const user = userEvent.setup()
    renderBar(<CaptureBar {...baseProps} onSubmit={vi.fn()} />)

    await user.type(field(), 'Task !')

    expect(screen.queryByTestId('capture-bar-ghost')).not.toBeInTheDocument()
  })

  it('leaves prose punctuation and code alone', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    renderBar(<CaptureBar {...quickAddProps} onSubmit={onSubmit} />)

    await user.type(field(), 'Ship it! Learn C++{enter}')

    expect(onSubmit.mock.calls[0][0]).toBe('Ship it! Learn C++')
    expect(onSubmit.mock.calls[0][1]).toMatchObject({ priority: 'none', projectId: null })
  })
})

// ============================================================================
// `[[` note picker — the one completion that is a list, not a ghost
// ============================================================================

describe('CaptureBar — [[ note picker', () => {
  const quickAddProps = {
    ...baseProps,
    quickAdd: { projects: mockProjects }
  }

  const options = (): HTMLElement[] => screen.getAllByRole('option')

  // userEvent reads `[` as the start of a key descriptor, so a literal `[[`
  // has to be typed as four brackets.
  const OPEN_PICKER = 'Draft the plan [[[['

  it('opens on [[ with recent notes and filters as you type', async () => {
    const user = userEvent.setup()
    renderBar(<CaptureBar {...quickAddProps} onSubmit={vi.fn()} />)

    await user.type(field(), OPEN_PICKER)
    await waitFor(() => expect(options()).toHaveLength(3))
    expect(options().map((option) => option.textContent)).toEqual([
      'Roadmap',
      'Q1 Goals',
      'Hiring plan'
    ])

    await user.type(field(), 'Q1')
    await waitFor(() => expect(options()).toHaveLength(1))
    expect(options()[0]).toHaveTextContent('Q1 Goals')
  })

  it('does not open for any other marker', async () => {
    const user = userEvent.setup()
    renderBar(<CaptureBar {...quickAddProps} onSubmit={vi.fn()} />)

    await user.type(field(), 'Task #lau')
    await waitFor(() => expect(ghost()).toBeInTheDocument())

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('writes the chosen title into the field on Enter', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    renderBar(<CaptureBar {...quickAddProps} onSubmit={onSubmit} />)

    await user.type(field(), OPEN_PICKER)
    await waitFor(() => expect(options()).toHaveLength(3))
    await user.keyboard('{Enter}')

    // Enter selected the note rather than submitting the task.
    expect(onSubmit).not.toHaveBeenCalled()
    expect(field()).toHaveValue('Draft the plan [[Roadmap]] ')
  })

  it('navigates with the arrow keys and selects with Tab', async () => {
    const user = userEvent.setup()
    renderBar(<CaptureBar {...quickAddProps} onSubmit={vi.fn()} />)

    await user.type(field(), OPEN_PICKER)
    await waitFor(() => expect(options()).toHaveLength(3))

    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}')
    expect(options()[1]).toHaveAttribute('aria-selected', 'true')

    await user.keyboard('{Tab}')
    expect(field()).toHaveValue('Draft the plan [[Q1 Goals]] ')
  })

  it('links the selected note on submit and drops the run from the title', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    renderBar(<CaptureBar {...quickAddProps} onSubmit={onSubmit} />)

    await user.type(field(), OPEN_PICKER)
    await waitFor(() => expect(options()).toHaveLength(3))
    await user.keyboard('{Enter}')
    await user.keyboard('{Enter}')

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0]).toBe('Draft the plan')
    expect(onSubmit.mock.calls[0][1]).toMatchObject({ linkedNoteIds: ['note-1'] })
  })

  it('resolves a hand-typed [[Title]] by exact title', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    renderBar(<CaptureBar {...quickAddProps} onSubmit={onSubmit} />)

    // The picker's fetch is what loads the pool; typing straight through it
    // never selects anything.
    await user.type(field(), OPEN_PICKER)
    await waitFor(() => expect(options()).toHaveLength(3))
    await user.type(field(), 'hiring plan]]')
    await user.keyboard('{Enter}')

    expect(onSubmit.mock.calls[0][0]).toBe('Draft the plan')
    expect(onSubmit.mock.calls[0][1]).toMatchObject({ linkedNoteIds: ['note-3'] })
  })

  it('links nothing when the title matches no note', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    renderBar(<CaptureBar {...quickAddProps} onSubmit={onSubmit} />)

    await user.type(field(), 'Draft the plan [[[[Nothing here]]{enter}')

    expect(onSubmit.mock.calls[0][0]).toBe('Draft the plan')
    expect(onSubmit.mock.calls[0][1]).toMatchObject({ linkedNoteIds: [] })
  })

  it('closes on Escape without clearing, and clears on the second Escape', async () => {
    const user = userEvent.setup()
    renderBar(<CaptureBar {...quickAddProps} onSubmit={vi.fn()} />)

    await user.type(field(), OPEN_PICKER)
    await waitFor(() => expect(options()).toHaveLength(3))

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(field()).toHaveValue('Draft the plan [[')

    await user.keyboard('{Escape}')
    expect(field()).toHaveValue('')
  })
})

// ============================================================================
// Shared geometry — the reason this component exists
// ============================================================================

describe('CaptureBar — shared geometry', () => {
  it('uses one box treatment regardless of which capabilities are on', () => {
    const { unmount } = renderBar(<CaptureBar {...baseProps} onSubmit={vi.fn()} />)
    const plain = screen.getByTestId('capture-bar-shell').className
    unmount()

    renderBar(
      <CaptureBar
        {...baseProps}
        onSubmit={vi.fn()}
        quickAdd={{ projects: mockProjects }}
        attachment={{ onAttach: vi.fn(), label: 'Attach files' }}
        voice={{ onComplete: vi.fn(), label: 'Record voice memo' }}
      />
    )
    const loaded = screen.getByTestId('capture-bar-shell').className

    expect(loaded).toBe(plain)
    for (const cls of ['px-2.5', 'py-1', 'rounded-md', 'border-[1.5px]', 'border-dashed']) {
      expect(plain).toContain(cls)
    }
  })

  it('uses one type scale for the field', () => {
    renderBar(<CaptureBar {...baseProps} onSubmit={vi.fn()} />)

    for (const cls of [
      'text-[12px]',
      'leading-[18px]',
      'min-h-[18px]',
      'placeholder:text-text-tertiary'
    ]) {
      expect(field().className).toContain(cls)
    }
  })

  // A narrow window wraps the placeholder over several lines, and an empty
  // textarea measures that placeholder — so the bar used to open at placeholder
  // height in a narrow toolbar. Height is only measured once there is text.
  describe('auto-grow', () => {
    // jsdom never lays out, so stand in for the wrapped measurement.
    const stubScrollHeight = (px: number): void => {
      Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
        configurable: true,
        get: () => px
      })
    }

    afterEach(() => {
      Reflect.deleteProperty(HTMLTextAreaElement.prototype, 'scrollHeight')
    })

    it('keeps the empty field at one row however tall the placeholder wraps', () => {
      stubScrollHeight(320)
      renderBar(<CaptureBar {...baseProps} onSubmit={vi.fn()} />)

      expect(field().style.height).toBe('auto')
    })

    it('grows to the typed text, up to the ceiling', async () => {
      const user = userEvent.setup()
      stubScrollHeight(320)
      renderBar(<CaptureBar {...baseProps} onSubmit={vi.fn()} />)

      await user.type(field(), 'a long capture that wraps')

      expect(field().style.height).toBe('200px')
    })

    it('falls back to one row when the text is cleared', async () => {
      const user = userEvent.setup()
      stubScrollHeight(320)
      renderBar(<CaptureBar {...baseProps} onSubmit={vi.fn()} />)

      await user.type(field(), 'draft')
      expect(field().style.height).toBe('200px')

      await user.clear(field())
      expect(field().style.height).toBe('auto')
    })
  })

  it('paints the focus border with the surface accent instead of a per-page colour', async () => {
    const user = userEvent.setup()
    renderBar(<CaptureBar {...baseProps} onSubmit={vi.fn()} accentColor="#3B82F6" />)

    const shell = screen.getByTestId('capture-bar-shell')
    expect(shell).toHaveClass('border-border')

    await user.click(field())

    // Same 1.5px dashed box, only the colour differs between surfaces.
    expect(shell.style.borderColor).not.toBe('')
    expect(shell.className).toContain('border-[1.5px]')
  })
})

// ============================================================================
// Natural-language quick-add (#129)
// ============================================================================

describe('CaptureBar — natural-language quick-add', () => {
  const quickAddProps = {
    ...baseProps,
    quickAdd: { projects: mockProjects }
  }

  it('parses an @ date phrase and an "every …" repeat out of the title', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    renderBar(<CaptureBar {...quickAddProps} onSubmit={onSubmit} />)

    await user.type(field(), 'Water plants @tomorrow every 2 weeks')
    await user.keyboard('{Enter}')

    expect(onSubmit).toHaveBeenCalledTimes(1)
    const [title, parsed] = onSubmit.mock.calls[0]
    expect(title).toBe('Water plants')
    expect(parsed.dueDate).toBeInstanceOf(Date)
    expect(parsed.repeat).toMatchObject({ frequency: 'weekly', interval: 2 })
  })

  it('paints a pill over each recognised phrase', async () => {
    const user = userEvent.setup()
    const { container } = renderBar(<CaptureBar {...quickAddProps} onSubmit={vi.fn()} />)

    await user.type(field(), 'Water plants @tomorrow every 2 weeks')

    const pills = [...container.querySelectorAll('span')].filter((span) =>
      span.className.includes('rounded-full')
    )
    expect(pills.map((pill) => pill.textContent)).toEqual(['@tomorrow', 'every 2 weeks'])
  })

  it('paints no pill over prose that only looks like syntax', async () => {
    const user = userEvent.setup()
    const { container } = renderBar(<CaptureBar {...quickAddProps} onSubmit={vi.fn()} />)

    await user.type(field(), 'Check every door')

    expect(container.querySelectorAll('span[class*="rounded-full"]')).toHaveLength(0)
  })

  it('ghosts the rest of a half-typed date phrase', async () => {
    const user = userEvent.setup()
    renderBar(<CaptureBar {...quickAddProps} onSubmit={vi.fn()} />)

    await user.type(field(), 'Call Bob @tomo')
    expect(ghost()).toHaveTextContent('rrow')

    await user.keyboard('{Tab}')
    expect(field()).toHaveValue('Call Bob @Tomorrow ')
  })

  it('ghosts the rest of a half-typed cadence', async () => {
    const user = userEvent.setup()
    renderBar(<CaptureBar {...quickAddProps} onSubmit={vi.fn()} />)

    await user.type(field(), 'Standup every week')
    expect(ghost()).toHaveTextContent('day')

    await user.keyboard('{ArrowRight}')
    expect(field()).toHaveValue('Standup every weekday ')
  })

  it('ghosts nothing for an "every" that is not a cadence', async () => {
    const user = userEvent.setup()
    renderBar(<CaptureBar {...quickAddProps} onSubmit={vi.fn()} />)

    await user.type(field(), 'Check every door')

    expect(screen.queryByTestId('capture-bar-ghost')).not.toBeInTheDocument()
  })
})
