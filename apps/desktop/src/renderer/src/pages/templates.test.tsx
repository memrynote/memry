import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TemplatesPage } from './templates'

const openTab = vi.fn()
const deleteTemplate = vi.fn()
const duplicateTemplate = vi.fn()
const toastSuccess = vi.fn()
const toastError = vi.fn()

let templatesState: Array<{
  id: string
  name: string
  description?: string
  icon?: string | null
  isBuiltIn: boolean
}> = []
let isLoadingState = false

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) ?? key })
}))

vi.mock('@/hooks/use-templates', () => ({
  useTemplates: () => ({
    templates: templatesState,
    isLoading: isLoadingState,
    deleteTemplate,
    duplicateTemplate
  })
}))

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({ openTab })
}))

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args)
  }
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn() })
}))

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div role="alertdialog">{children}</div> : null,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
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

describe('TemplatesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isLoadingState = false
    templatesState = [
      {
        id: 'custom-1',
        name: 'Meeting Notes',
        description: 'Agenda and follow-ups',
        icon: '📝',
        isBuiltIn: false
      },
      {
        id: 'builtin-1',
        name: 'Daily Journal',
        description: 'Built in structure',
        icon: null,
        isBuiltIn: true
      }
    ]
    deleteTemplate.mockResolvedValue(true)
    duplicateTemplate.mockResolvedValue({ id: 'copy-1' })
  })

  it('renders the loading state', () => {
    isLoadingState = true

    render(<TemplatesPage />)

    expect(screen.getByText('loadingCollection')).toBeInTheDocument()
  })

  it('opens the new-template editor from header and empty state actions', async () => {
    const user = userEvent.setup()
    templatesState = []

    render(<TemplatesPage />)

    await user.click(screen.getByRole('button', { name: /newTemplate/ }))
    await user.click(screen.getByRole('button', { name: /createTemplate/ }))

    expect(openTab).toHaveBeenCalledTimes(2)
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'template-editor',
        title: 'New Template',
        path: '/templates/new'
      })
    )
  })

  it('opens, duplicates, and deletes custom templates', async () => {
    const user = userEvent.setup()

    render(<TemplatesPage />)

    await user.click(screen.getByRole('button', { name: 'Edit template: Meeting Notes' }))
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'template-editor',
        title: 'Meeting Notes',
        path: '/templates/custom-1',
        entityId: 'custom-1'
      })
    )

    await user.click(screen.getAllByTitle('duplicate')[0])
    await waitFor(() =>
      expect(duplicateTemplate).toHaveBeenCalledWith('custom-1', 'Meeting Notes (Copy)')
    )
    expect(toastSuccess).toHaveBeenCalledWith('Duplicated "Meeting Notes"')

    await user.click(screen.getByTitle('delete'))
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(deleteTemplate).toHaveBeenCalledWith('custom-1'))
    expect(toastSuccess).toHaveBeenCalledWith('Deleted "Meeting Notes"')
  })

  it('shows duplicate/delete failure toasts and opens built-in templates read-only', async () => {
    const user = userEvent.setup()
    duplicateTemplate.mockResolvedValue(null)
    deleteTemplate.mockResolvedValue(false)

    render(<TemplatesPage />)

    await user.click(screen.getAllByTitle('duplicate')[1])
    await waitFor(() =>
      expect(duplicateTemplate).toHaveBeenCalledWith('builtin-1', 'Daily Journal (Copy)')
    )
    expect(toastError).toHaveBeenCalledWith('duplicateFailed')

    await user.click(screen.getByTitle('delete'))
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('deleteFailed'))

    await user.click(screen.getByRole('button', { name: 'Edit template: Daily Journal' }))
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Daily Journal',
        path: '/templates/builtin-1'
      })
    )
  })
})
