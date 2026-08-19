import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ProjectModal } from './project-modal'
import type { Project, Status } from '@/data/tasks-data'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) ?? key })
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({
    open,
    children
  }: {
    open: boolean
    onOpenChange?: (open: boolean) => void
    children: React.ReactNode
  }) => (open ? <div role="dialog">{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>
}))

vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({
    open,
    children
  }: {
    open: boolean
    onOpenChange?: (open: boolean) => void
    children: React.ReactNode
  }) => (open ? <div role="alertdialog">{children}</div> : null),
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h3>{children}</h3>,
  // A div, not a p: the real AlertDialogDescription takes `asChild`, and the
  // delete-confirm passes a <div> body through it.
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({
    children,
    onClick
  }: {
    children: React.ReactNode
    onClick?: () => void
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  AlertDialogAction: ({
    children,
    onClick
  }: {
    children: React.ReactNode
    onClick?: () => void
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  )
}))

// The icon lives inside a Radix Popover in real code; passthrough mocks keep the
// flow deterministic (Radix Popover open/focus is unreliable under jsdom).
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

// The shared emoji/icon picker. "pick Star" emits an icon: value; Remove clears it.
vi.mock('@/components/note/note-title/EmojiPicker', () => ({
  EmojiPicker: ({
    onSelect,
    onRemove,
    hasEmoji
  }: {
    onSelect: (value: string) => void
    onRemove: () => void
    hasEmoji: boolean
  }) => (
    <div role="listbox" aria-label="icon-picker">
      <button type="button" onClick={() => onSelect('icon:StarIcon')}>
        pick Star
      </button>
      {hasEmoji && (
        <button type="button" onClick={onRemove}>
          remove icon
        </button>
      )}
    </div>
  )
}))

vi.mock('@/components/tasks/project-icon', () => ({
  ProjectIcon: ({ icon, fallback }: { icon: string | null; fallback: React.ReactNode }) =>
    icon ? <span data-testid="project-icon">{icon}</span> : <>{fallback}</>
}))

vi.mock('@/components/tasks/color-picker', () => ({
  ColorPicker: ({ onChange }: { value: string; onChange: (color: string) => void }) => (
    <button type="button" onClick={() => onChange('#00f')}>
      pick blue
    </button>
  )
}))

const invalidStatuses: Status[] = [{ id: 'todo', name: '', color: '#777', type: 'todo', order: 0 }]
const validStatuses: Status[] = [
  { id: 'todo', name: 'Todo', color: '#777', type: 'todo', order: 0 },
  { id: 'done', name: 'Done', color: '#0a0', type: 'done', order: 1 }
]

vi.mock('@/components/tasks/status-editor', () => ({
  StatusEditor: ({
    onChange,
    error
  }: {
    statuses: Status[]
    onChange: (statuses: Status[]) => void
    error?: string
  }) => (
    <div>
      {error && <span>{error}</span>}
      <button type="button" onClick={() => onChange(invalidStatuses)}>
        invalid statuses
      </button>
      <button type="button" onClick={() => onChange(validStatuses)}>
        valid statuses
      </button>
    </div>
  )
}))

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'Personal',
    description: 'Default work',
    icon: 'Folder',
    color: '#6366f1',
    statuses: validStatuses,
    isDefault: false,
    isArchived: false,
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    taskCount: 2,
    ...overrides
  }
}

describe('ProjectModal', () => {
  it('creates a project with edited fields, icon, color, and statuses', async () => {
    const onSave = vi.fn()
    const onClose = vi.fn()

    render(<ProjectModal isOpen onClose={onClose} onSave={onSave} />)

    fireEvent.change(screen.getByPlaceholderText('projectName'), { target: { value: 'Launch' } })
    fireEvent.change(screen.getByPlaceholderText('briefDescriptionOfThisProject'), {
      target: { value: 'Ship checklist' }
    })
    // The picker is lazy-loaded; findBy flushes the Suspense boundary.
    fireEvent.click(await screen.findByRole('button', { name: 'pick Star' }))
    fireEvent.click(screen.getByRole('button', { name: 'pick blue' }))
    fireEvent.click(screen.getByRole('button', { name: 'valid statuses' }))

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Launch',
        description: 'Ship checklist',
        icon: 'icon:StarIcon',
        color: '#00f',
        statuses: validStatuses,
        isDefault: false,
        isArchived: false,
        taskCount: 0
      })
    )
    expect(onSave.mock.calls[0][0].id).toMatch(/^project-/)
    expect(onClose).toHaveBeenCalled()
  })

  it('edits, deletes, validates statuses, and confirms discarding changes', async () => {
    const onSave = vi.fn()
    const onClose = vi.fn()
    const onDelete = vi.fn()

    render(
      <ProjectModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        onDelete={onDelete}
        project={makeProject({ icon: 'MissingIcon' })}
      />
    )

    // Flush the lazy-loaded icon picker's Suspense boundary before sync assertions.
    await screen.findByRole('button', { name: 'pick Star' })
    expect(screen.getByText('Edit Project')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'deleteProject' }))
    // The footer button only opens the confirm step; the second one commits.
    fireEvent.click(screen.getAllByRole('button', { name: 'deleteProject' })[1])
    expect(onDelete).toHaveBeenCalledWith('project-1')

    fireEvent.click(screen.getByRole('button', { name: 'invalid statuses' }))
    expect(screen.getByText('Projects need at least 2 statuses')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'valid statuses' }))
    fireEvent.change(screen.getByDisplayValue('Personal'), { target: { value: 'Work' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: 'project-1', name: 'Work' }))
    onClose.mockClear()

    fireEvent.change(screen.getByDisplayValue('Work'), { target: { value: 'Changed again' } })
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'cancel2' }))
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'discard' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('confirms before deleting and cancelling keeps the project', async () => {
    const onClose = vi.fn()
    const onDelete = vi.fn()

    render(
      <ProjectModal
        isOpen
        onClose={onClose}
        onSave={vi.fn()}
        onDelete={onDelete}
        project={makeProject()}
      />
    )

    // Flush the lazy-loaded icon picker's Suspense boundary before sync assertions.
    await screen.findByRole('button', { name: 'pick Star' })
    fireEvent.click(screen.getByRole('button', { name: 'deleteProject' }))

    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(onDelete).not.toHaveBeenCalled()

    // The confirm dialog's own cancel is the second one on screen.
    fireEvent.click(screen.getAllByRole('button', { name: 'cancel' })[1])
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(onDelete).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes the modal after deleting a project', async () => {
    const onClose = vi.fn()
    const onDelete = vi.fn()

    render(
      <ProjectModal
        isOpen
        onClose={onClose}
        onSave={vi.fn()}
        onDelete={onDelete}
        project={makeProject()}
      />
    )

    // Flush the lazy-loaded icon picker's Suspense boundary before sync assertions.
    await screen.findByRole('button', { name: 'pick Star' })
    fireEvent.click(screen.getByRole('button', { name: 'deleteProject' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'deleteProject' })[1])

    expect(onDelete).toHaveBeenCalledWith('project-1')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('hides delete for default projects and closes clean forms immediately', async () => {
    const onClose = vi.fn()
    render(
      <ProjectModal
        isOpen
        onClose={onClose}
        onSave={vi.fn()}
        onDelete={vi.fn()}
        project={makeProject({ isDefault: true })}
      />
    )

    // Flush the lazy-loaded icon picker's Suspense boundary before sync assertions.
    await screen.findByRole('button', { name: 'pick Star' })
    expect(screen.queryByRole('button', { name: 'deleteProject' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))
    expect(onClose).toHaveBeenCalled()
  })
})
