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
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
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

vi.mock('@/components/icon-picker', () => ({
  getIconByName: (name: string) =>
    name === 'MissingIcon' ? null : (props: { className?: string }) => <span {...props}>icon</span>,
  IconPicker: ({
    isOpen,
    onClose,
    onSelect,
    currentIcon
  }: {
    isOpen: boolean
    onClose: () => void
    onSelect: (iconName: string) => void
    currentIcon: string
  }) =>
    isOpen ? (
      <div role="listbox" aria-label={`icons-${currentIcon}`}>
        <button type="button" onClick={() => onSelect('Star')}>
          icon Star
        </button>
        <button type="button" onClick={onClose}>
          close icons
        </button>
      </div>
    ) : null
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
  it('creates a project with edited fields, icon, color, and statuses', () => {
    const onSave = vi.fn()
    const onClose = vi.fn()

    render(<ProjectModal isOpen onClose={onClose} onSave={onSave} />)

    fireEvent.change(screen.getByPlaceholderText('projectName'), { target: { value: 'Launch' } })
    fireEvent.change(screen.getByPlaceholderText('briefDescriptionOfThisProject'), {
      target: { value: 'Ship checklist' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'selectIcon' }))
    fireEvent.click(screen.getByRole('button', { name: 'icon Star' }))
    fireEvent.click(screen.getByRole('button', { name: 'pick blue' }))
    fireEvent.click(screen.getByRole('button', { name: 'valid statuses' }))

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Launch',
        description: 'Ship checklist',
        icon: 'Star',
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

  it('edits, deletes, validates statuses, and confirms discarding changes', () => {
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

    expect(screen.getByText('Edit Project')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'deleteProject' }))
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

  it('hides delete for default projects and closes clean forms immediately', () => {
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

    expect(screen.queryByRole('button', { name: 'deleteProject' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))
    expect(onClose).toHaveBeenCalled()
  })
})
