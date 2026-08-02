/**
 * CaptureBar tests.
 *
 * CaptureBar is the single capture field behind Inbox, Tasks and the Project
 * hub, so these cover three things: the keyboard contract, the capability
 * matrix (an affordance must not render unless its prop is passed), and the
 * shared geometry — the three surfaces drifting apart is the bug this
 * component exists to prevent.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
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

const mocks = vi.hoisted(() => ({ recorderStart: vi.fn() }))

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

beforeEach(() => {
  vi.clearAllMocks()
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

  it('parses date, priority and project out of the title', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    renderBar(<CaptureBar {...quickAddProps} onSubmit={onSubmit} />)

    await user.type(field(), 'Buy groceries !tomorrow !!high #Personal')
    await user.keyboard('{Escape}')
    await user.keyboard('{Enter}')

    expect(onSubmit).toHaveBeenCalledTimes(1)
    const [title, parsed] = onSubmit.mock.calls[0]
    expect(title).toBe('Buy groceries')
    expect(parsed).toMatchObject({ priority: 'high', projectId: 'project-1' })
    expect(parsed.dueDate).toBeInstanceOf(Date)
  })

  it('passes no parsed data when quick-add is off', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    renderBar(<CaptureBar {...baseProps} onSubmit={onSubmit} />)

    await user.type(field(), 'Buy groceries !tomorrow{enter}')

    expect(onSubmit).toHaveBeenCalledWith('Buy groceries !tomorrow')
  })

  it('offers date options on !, priority on !! and projects on #', async () => {
    const user = userEvent.setup()
    renderBar(<CaptureBar {...quickAddProps} onSubmit={vi.fn()} />)

    await user.type(field(), 'Task !')
    expect(screen.getAllByText(/today/i).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/tomorrow/i).length).toBeGreaterThanOrEqual(1)

    await user.clear(field())
    await user.type(field(), 'Task !!')
    expect(screen.getAllByText(/high/i).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/urgent/i).length).toBeGreaterThanOrEqual(1)

    await user.clear(field())
    await user.type(field(), 'Task #')
    expect(screen.getAllByText(/personal/i).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/work/i).length).toBeGreaterThanOrEqual(1)
  })

  it('filters options as the token is typed', async () => {
    const user = userEvent.setup()
    renderBar(<CaptureBar {...quickAddProps} onSubmit={vi.fn()} />)

    await user.type(field(), 'Task #per')

    expect(screen.getAllByText(/personal/i).length).toBeGreaterThanOrEqual(1)
    expect(screen.queryAllByText(/^Work$/).length).toBe(0)
  })

  it('detects the trigger on the last line of a multi-line capture', async () => {
    const user = userEvent.setup()
    renderBar(<CaptureBar {...quickAddProps} onSubmit={vi.fn()} />)

    await user.type(field(), 'First line{Shift>}{Enter}{/Shift}#per')

    expect(screen.getAllByText(/personal/i).length).toBeGreaterThanOrEqual(1)
  })

  it('inserts the selected option in place of the trigger token', async () => {
    const user = userEvent.setup()
    renderBar(<CaptureBar {...quickAddProps} onSubmit={vi.fn()} />)

    await user.type(field(), 'Task #per')
    await user.click(screen.getByRole('option', { name: /personal/i }))

    expect(field()).toHaveValue('Task #Personal ')
  })

  it('closes the dropdown on the first Escape and clears on the second', async () => {
    const user = userEvent.setup()
    renderBar(<CaptureBar {...quickAddProps} onSubmit={vi.fn()} />)

    await user.type(field(), 'Task !')
    expect(screen.getAllByText(/today/i).length).toBeGreaterThanOrEqual(1)

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(field()).toHaveValue('')
  })

  it('submits on Enter when the trailing token is already an exact match', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    renderBar(<CaptureBar {...quickAddProps} onSubmit={onSubmit} />)

    await user.type(field(), 'Important task !!high')
    await user.keyboard('{Enter}')

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0]).toBe('Important task')
    expect(onSubmit.mock.calls[0][1]).toMatchObject({ priority: 'high' })
    await waitFor(() => expect(field()).toHaveValue(''))
  })

  it('renders no dropdown for plain prose', async () => {
    const user = userEvent.setup()
    renderBar(<CaptureBar {...quickAddProps} onSubmit={vi.fn()} />)

    await user.type(field(), 'Buy groceries')

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('renders no dropdown when quick-add is off', async () => {
    const user = userEvent.setup()
    renderBar(<CaptureBar {...baseProps} onSubmit={vi.fn()} />)

    await user.type(field(), 'Task !')

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
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
