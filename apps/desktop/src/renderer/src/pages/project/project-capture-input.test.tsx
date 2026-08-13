/**
 * Project hub capture tests.
 *
 * The hub reuses CaptureBar, so these cover the wiring the hub owns: quick-add
 * text becomes a task, a bare URL becomes a linked note, the paperclip imports
 * files — and voice, which the hub does not support, is absent.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import type { ReactElement, ReactNode } from 'react'
import { createRendererI18n } from '@memry/i18n/renderer'
import { ProjectCaptureInput } from './project-capture-input'
import type { Project } from '@/data/tasks-data'

Element.prototype.scrollIntoView = vi.fn()

const mocks = vi.hoisted(() => ({
  captureUrlToProject: vi.fn(),
  importFilesToProject: vi.fn(),
  showImportDialog: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    captureUrlToProject: (...args: unknown[]) => mocks.captureUrlToProject(...args),
    importFilesToProject: (...args: unknown[]) => mocks.importFilesToProject(...args)
  }
}))

vi.mock('@/services/notes-service', () => ({
  notesService: {
    showImportDialog: (...args: unknown[]) => mocks.showImportDialog(...args)
  }
}))

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mocks.toastSuccess(...args),
    error: (...args: unknown[]) => mocks.toastError(...args)
  }
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

let i18nEn: I18nInstance

beforeAll(async () => {
  i18nEn = await createRendererI18n({ locale: 'en' })
})

function renderCapture(ui: ReactElement) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <I18nextProvider i18n={i18nEn}>{children}</I18nextProvider>
  )
  return render(ui, { wrapper: Wrapper })
}

const project: Project = {
  id: 'project-1',
  name: 'Acme',
  isDefault: false,
  isArchived: false,
  position: 0,
  statuses: [],
  color: '#3B82F6',
  icon: 'folder'
}

const projects: Project[] = [project]

const field = (): HTMLTextAreaElement =>
  screen.getByRole('textbox', { name: 'Add to Acme' }) as HTMLTextAreaElement

function setup(overrides: Partial<React.ComponentProps<typeof ProjectCaptureInput>> = {}) {
  const props = {
    project,
    projects,
    onAddTask: vi.fn(),
    onChanged: vi.fn(),
    ...overrides
  }
  const view = renderCapture(<ProjectCaptureInput {...props} />)
  return { ...view, props }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.captureUrlToProject.mockResolvedValue({ success: true })
  mocks.importFilesToProject.mockResolvedValue({ linked: ['a'], failed: [] })
  mocks.showImportDialog.mockResolvedValue({ canceled: true, filePaths: [] })
})

describe('ProjectCaptureInput — toolbar shell', () => {
  it('inherits the toolbar type scale so focus cannot resize the row', () => {
    const { container } = setup()

    // The unfocused shortcut badge sets no font-size of its own. Outside the
    // toolbar's 12px/16px context it inherits the page's 14px/1.5 strut, grows
    // taller than the action buttons, and the box shrinks when focus unmounts
    // it — the shift Inbox and Tasks do not have.
    const toolbar = container.firstElementChild
    expect(toolbar?.className).toContain('text-[12px]')
    expect(toolbar?.className).toContain('leading-4')
    expect(toolbar?.className).toContain('min-h-[38px]')
  })
})

describe('ProjectCaptureInput — text capture', () => {
  it('names the project in the placeholder', () => {
    setup()

    expect(
      screen.getByPlaceholderText(/Add to Acme — type a task, jot a note, or paste a link/)
    ).toBeInTheDocument()
  })

  it('adds plain text as a task in this project', async () => {
    const user = userEvent.setup()
    const { props } = setup()

    await user.type(field(), 'Draft the brief{enter}')

    expect(props.onAddTask).toHaveBeenCalledWith(
      'Draft the brief',
      expect.objectContaining({ dueDate: null, priority: 'none', projectId: null })
    )
    expect(mocks.captureUrlToProject).not.toHaveBeenCalled()
  })

  it('still parses quick-add syntax', async () => {
    const user = userEvent.setup()
    const { props } = setup()

    await user.type(field(), 'Draft the brief !high')
    await user.keyboard('{Enter}')

    expect(props.onAddTask).toHaveBeenCalledWith(
      'Draft the brief',
      expect.objectContaining({ priority: 'high' })
    )
  })
})

describe('ProjectCaptureInput — link capture', () => {
  it('turns a bare URL into a linked note and refreshes the hub', async () => {
    const user = userEvent.setup()
    const { props } = setup()

    await user.type(field(), 'example.com/spec{enter}')

    await waitFor(() =>
      expect(mocks.captureUrlToProject).toHaveBeenCalledWith({
        projectId: 'project-1',
        url: 'https://example.com/spec'
      })
    )
    expect(props.onAddTask).not.toHaveBeenCalled()
    expect(props.onChanged).toHaveBeenCalledTimes(1)
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Link added to the project')
  })

  it('reports a failed link capture without refreshing', async () => {
    const user = userEvent.setup()
    mocks.captureUrlToProject.mockResolvedValueOnce({ success: false, error: 'offline' })
    const { props } = setup()

    await user.type(field(), 'example.com/spec{enter}')

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('offline'))
    expect(props.onChanged).not.toHaveBeenCalled()
  })
})

describe('ProjectCaptureInput — file import', () => {
  it('imports the picked files and refreshes the hub', async () => {
    const user = userEvent.setup()
    mocks.showImportDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/tmp/spec.pdf']
    })
    const { props } = setup()

    await user.click(screen.getByRole('button', { name: 'Attach files' }))

    await waitFor(() =>
      expect(mocks.importFilesToProject).toHaveBeenCalledWith({
        projectId: 'project-1',
        sourcePaths: ['/tmp/spec.pdf']
      })
    )
    expect(props.onChanged).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the picker is cancelled', async () => {
    const user = userEvent.setup()
    const { props } = setup()

    await user.click(screen.getByRole('button', { name: 'Attach files' }))

    await waitFor(() => expect(mocks.showImportDialog).toHaveBeenCalled())
    expect(mocks.importFilesToProject).not.toHaveBeenCalled()
    expect(props.onChanged).not.toHaveBeenCalled()
  })

  it('reports per-file failures', async () => {
    const user = userEvent.setup()
    mocks.showImportDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/tmp/broken.pdf']
    })
    mocks.importFilesToProject.mockResolvedValueOnce({
      linked: [],
      failed: [{ path: '/tmp/broken.pdf', error: 'nope' }]
    })
    setup()

    await user.click(screen.getByRole('button', { name: 'Attach files' }))

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('Could not link /tmp/broken.pdf')
    )
  })

  it('opens the picker when importSignal changes, but not on first render', async () => {
    const { rerender, props } = setup({ importSignal: 0 })

    expect(mocks.showImportDialog).not.toHaveBeenCalled()

    // Bare element: rerender re-applies the wrapper, and wrapping it again here
    // would remount the component instead of updating the mounted one.
    rerender(<ProjectCaptureInput {...props} importSignal={1} />)

    await waitFor(() => expect(mocks.showImportDialog).toHaveBeenCalledTimes(1))
  })
})

describe('ProjectCaptureInput — capability matrix', () => {
  it('offers attachment but no voice recording', () => {
    setup()

    expect(screen.getByRole('button', { name: 'Attach files' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /voice/i })).not.toBeInTheDocument()
  })

  it('uses the project colour as the focus accent', async () => {
    const user = userEvent.setup()
    setup()

    await user.click(field())

    expect(screen.getByTestId('capture-bar-shell').style.borderColor).not.toBe('')
  })
})
