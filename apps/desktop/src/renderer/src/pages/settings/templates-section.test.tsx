import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TemplatesSettings } from './templates-section'

const openTab = vi.fn()
const deleteTemplate = vi.fn()
const duplicateTemplate = vi.fn()
const toastSuccess = vi.fn()
const toastError = vi.fn()
const closeSettings = vi.fn()

let templatesState: Array<{
  id: string
  name: string
  description?: string
  icon?: string | null
  isBuiltIn: boolean
}> = []
let isLoadingState = false

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (key === 'templates.copySuffix') return `${String(values?.name)} Copy`
      return key
    }
  })
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

vi.mock('@/contexts/settings-modal-context', () => ({
  useSettingsModal: () => ({ close: closeSettings })
}))

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args)
  }
}))

vi.mock('@/components/settings/settings-primitives', () => ({
  SettingsHeader: ({
    title,
    subtitle,
    action
  }: {
    title: string
    subtitle: string
    action?: React.ReactNode
  }) => (
    <header>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {action}
    </header>
  ),
  SettingsGroup: ({ label, children }: { label: string; children: React.ReactNode }) => (
    <section aria-label={label}>{children}</section>
  )
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  // Faithful to production: the real DropdownMenuContent carries the stopPropagation
  // that keeps menu-item clicks (which bubble through the React tree even when portaled)
  // from reaching the row's onSelect. The mock applies the same onClick so the test
  // exercises the real guard rather than a fabricated one in DropdownMenuItem.
  DropdownMenuContent: ({
    children,
    onClick
  }: {
    children: React.ReactNode
    onClick?: (e: React.MouseEvent) => void
  }) => <div onClick={onClick}>{children}</div>,
  DropdownMenuItem: ({
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

describe('TemplatesSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isLoadingState = false
    templatesState = [
      {
        id: 'built-in',
        name: 'Daily Journal',
        description: 'Default daily shape',
        icon: null,
        isBuiltIn: true
      },
      {
        id: 'custom',
        name: 'Meeting Notes',
        description: 'Agenda and decisions',
        icon: 'M',
        isBuiltIn: false
      }
    ]
    deleteTemplate.mockResolvedValue(true)
    duplicateTemplate.mockResolvedValue({ id: 'copy' })
  })

  it('renders loading and empty custom-template states', () => {
    isLoadingState = true
    const { rerender } = render(<TemplatesSettings />)
    expect(screen.getByText('templates.loading')).toBeInTheDocument()

    isLoadingState = false
    templatesState = []
    rerender(<TemplatesSettings />)
    expect(screen.getByText('templates.empty.title')).toBeInTheDocument()
    expect(screen.getByText('templates.empty.description')).toBeInTheDocument()
  })

  it('opens create and edit tabs', async () => {
    const user = userEvent.setup()
    render(<TemplatesSettings />)

    await user.click(screen.getByRole('button', { name: /templates.actions.new/ }))
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'template-editor',
        title: 'templates.newTemplateTitle',
        path: '/templates/new'
      })
    )

    await user.click(screen.getByRole('button', { name: /templates.actions.edit/ }))
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'template-editor',
        title: 'Meeting Notes',
        path: '/templates/custom',
        entityId: 'custom'
      })
    )
  })

  it('duplicates custom templates', async () => {
    const user = userEvent.setup()
    render(<TemplatesSettings />)

    await user.click(screen.getByRole('button', { name: /templates.actions.duplicate/ }))
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Meeting Notes Copy')).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: 'templates.actions.duplicate' }).at(-1)!)

    await waitFor(() =>
      expect(duplicateTemplate).toHaveBeenCalledWith('custom', 'Meeting Notes Copy')
    )
    expect(toastSuccess).toHaveBeenCalledWith('templates.toasts.duplicated')
  })

  it('deletes custom templates and reports mutation failures', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<TemplatesSettings />)

    await user.click(screen.getByRole('button', { name: /templates.actions.delete/ }))
    await user.click(screen.getByRole('button', { name: 'button.delete' }))
    await waitFor(() => expect(deleteTemplate).toHaveBeenCalledWith('custom'))
    expect(toastSuccess).toHaveBeenCalledWith('templates.toasts.deleted')

    deleteTemplate.mockResolvedValue(false)
    duplicateTemplate.mockResolvedValue(null)
    rerender(<TemplatesSettings />)

    await user.click(screen.getByRole('button', { name: /templates.actions.delete/ }))
    await user.click(screen.getByRole('button', { name: 'button.delete' }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('templates.toasts.deleteFailed'))

    await user.click(screen.getByRole('button', { name: /templates.actions.duplicate/ }))
    await user.clear(screen.getByDisplayValue('Meeting Notes Copy'))
    await user.click(screen.getAllByRole('button', { name: 'templates.actions.duplicate' }).at(-1)!)
    expect(duplicateTemplate).not.toHaveBeenCalled()

    await user.type(screen.getByRole('textbox'), 'Copy')
    await user.click(screen.getAllByRole('button', { name: 'templates.actions.duplicate' }).at(-1)!)
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('templates.toasts.duplicateFailed'))
  })

  it('closes settings modal when creating a template', async () => {
    const user = userEvent.setup()
    render(<TemplatesSettings />)
    await user.click(screen.getByRole('button', { name: /templates.actions.new/ }))
    expect(closeSettings).toHaveBeenCalledTimes(1)
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'template-editor', path: '/templates/new' })
    )
  })

  it('closes settings modal when editing a template', async () => {
    const user = userEvent.setup()
    render(<TemplatesSettings />)
    await user.click(screen.getByRole('button', { name: /templates.actions.edit/ }))
    expect(closeSettings).toHaveBeenCalledTimes(1)
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'template-editor', path: '/templates/custom' })
    )
  })
})

describe('TemplatesSettings — row click', () => {
  it('opens the editor tab when a row is clicked', async () => {
    const user = userEvent.setup()
    render(<TemplatesSettings />)

    await user.click(await screen.findByRole('button', { name: 'Meeting Notes' }))

    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'template-editor', entityId: 'custom' })
    )
    expect(closeSettings).toHaveBeenCalled()
  })

  it('opens built-in templates in the same tab type', async () => {
    const user = userEvent.setup()
    render(<TemplatesSettings />)

    await user.click(await screen.findByRole('button', { name: 'Daily Journal' }))

    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'template-editor', entityId: 'built-in' })
    )
  })

  it('clicking a dropdown menu item does not also open the row tab', async () => {
    const user = userEvent.setup()
    render(<TemplatesSettings />)
    // DropdownMenuContent's stopPropagation keeps the menu-item click from reaching
    // the row's onSelect (matches production); Duplicate must not open a tab.
    await user.click(screen.getByRole('button', { name: /templates.actions.duplicate/ }))
    expect(openTab).not.toHaveBeenCalled()
  })
})
