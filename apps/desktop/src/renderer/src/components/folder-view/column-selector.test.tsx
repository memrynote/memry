import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ColumnSelector } from './column-selector'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params?.count ?? key.split('.').at(-1) ?? key
  })
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <span>{children}</span>
}))

vi.mock('@/components/ui/checkbox', () => ({
  Checkbox: ({
    id,
    checked,
    onCheckedChange
  }: {
    id?: string
    checked?: boolean
    onCheckedChange?: (checked: boolean) => void
  }) => (
    <input
      id={id}
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange?.(event.target.checked)}
    />
  )
}))

vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children
  }: {
    value: string
    onValueChange: (value: string) => void
    children: React.ReactNode
  }) => (
    <label>
      summary
      <select
        aria-label="summary selector"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      >
        <option value="none">none</option>
        <option value="count">count</option>
        <option value="sum">sum</option>
      </select>
      {children}
    </label>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <span data-value={value}>{children}</span>
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

vi.mock('./formula-editor-modal', () => ({
  FormulaEditorModal: ({
    open,
    initialName,
    initialExpression,
    onSave
  }: {
    open: boolean
    initialName: string
    initialExpression: string
    onSave: (name: string, expression: string) => Promise<void>
  }) =>
    open ? (
      <div role="dialog">
        <span>formula editor {initialName || 'new'}</span>
        <button
          type="button"
          onClick={() => void onSave(initialName || 'createdFormula', initialExpression || '1 + 2')}
        >
          save formula
        </button>
      </div>
    ) : null
}))

const builtInColumns = [
  { id: 'title', displayName: 'Title', type: 'text' },
  { id: 'status', displayName: 'Status', type: 'text' }
]

const availableProperties = [
  { name: 'priority', type: 'number', usageCount: 4 },
  { name: 'owner', type: 'text', usageCount: 2 }
]

describe('ColumnSelector', () => {
  it('filters columns, toggles visibility, and updates summaries', () => {
    const onColumnsChange = vi.fn()
    const onSearchChange = vi.fn()
    const onSummaryChange = vi.fn()

    const { container } = render(
      <ColumnSelector
        columns={[
          { id: 'title', width: 250 },
          { id: 'status', width: 120 }
        ]}
        builtInColumns={builtInColumns}
        availableProperties={availableProperties}
        onColumnsChange={onColumnsChange}
        onSearchChange={onSearchChange}
        summaries={{ title: { type: 'count' } }}
        onSummaryChange={onSummaryChange}
      />
    )

    fireEvent.change(screen.getByPlaceholderText('searchColumns'), { target: { value: 'prio' } })
    expect(onSearchChange).toHaveBeenCalledWith('prio')
    expect(screen.getByText('priority')).toBeInTheDocument()
    expect(screen.queryByText('Status')).not.toBeInTheDocument()

    fireEvent.click(container.querySelector('#col-priority')!)
    expect(onColumnsChange).toHaveBeenCalledWith([
      { id: 'title', width: 250 },
      { id: 'status', width: 120 },
      { id: 'priority', width: 120 }
    ])

    fireEvent.change(screen.getByPlaceholderText('searchColumns'), { target: { value: '' } })
    // Title is locked (always visible) — it has no toggle checkbox.
    expect(container.querySelector('#col-title')).toBeNull()
    fireEvent.click(container.querySelector('#col-status')!)
    expect(onColumnsChange).toHaveBeenLastCalledWith([{ id: 'title', width: 250 }])

    fireEvent.change(screen.getAllByLabelText('summary selector')[0], { target: { value: 'none' } })
    expect(onSummaryChange).toHaveBeenCalledWith('title', undefined)
  })

  it('adds, edits, deletes, and hides formula columns', async () => {
    const onColumnsChange = vi.fn()
    const onFormulaAdd = vi.fn().mockResolvedValue(undefined)
    const onFormulaEdit = vi.fn().mockResolvedValue(undefined)
    const onFormulaDelete = vi.fn().mockResolvedValue(undefined)

    const { container } = render(
      <ColumnSelector
        columns={[
          { id: 'title', width: 250 },
          { id: 'formula.Score', width: 120 }
        ]}
        builtInColumns={builtInColumns}
        availableProperties={availableProperties}
        formulas={[{ id: 'Score', expression: 'priority * 2' }]}
        onColumnsChange={onColumnsChange}
        onFormulaAdd={onFormulaAdd}
        onFormulaEdit={onFormulaEdit}
        onFormulaDelete={onFormulaDelete}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /addFormula/ }))
    fireEvent.click(screen.getByRole('button', { name: 'save formula' }))
    await waitFor(() => expect(onFormulaAdd).toHaveBeenCalledWith('createdFormula', '1 + 2'))

    const formulaRow = screen.getByText('Score').closest('div')!
    fireEvent.click(within(formulaRow).getAllByRole('button')[0])
    expect(screen.getByText('formula editor Score')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'save formula' }))
    await waitFor(() => expect(onFormulaEdit).toHaveBeenCalledWith('Score', 'priority * 2'))

    fireEvent.click(within(formulaRow).getAllByRole('button')[1])
    fireEvent.click(screen.getByRole('button', { name: 'delete' }))

    await waitFor(() => expect(onFormulaDelete).toHaveBeenCalledWith('Score'))
    expect(onColumnsChange).toHaveBeenCalledWith([{ id: 'title', width: 250 }])
    expect(container).toHaveTextContent('formulas')
  })
})
