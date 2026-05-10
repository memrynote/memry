import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type React from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { RepeatConfig } from '@/data/task-model'
import { CustomRepeatDialog } from './custom-repeat-dialog'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) ?? key })
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({
    open,
    onOpenChange,
    children
  }: {
    open: boolean
    onOpenChange?: (open: boolean) => void
    children: React.ReactNode
  }) => (
    <div data-open={open}>
      {children}
      <button type="button" onClick={() => onOpenChange?.(false)}>
        mock dialog close
      </button>
    </div>
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <footer>{children}</footer>
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    disabled,
    onClick,
    type = 'button'
  }: {
    children: React.ReactNode
    disabled?: boolean
    onClick?: () => void
    type?: 'button' | 'submit' | 'reset'
  }) => (
    <button type={type} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  )
}))

vi.mock('@/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />
}))

vi.mock('@/components/ui/label', () => ({
  Label: ({ children }: { children: React.ReactNode }) => <label>{children}</label>
}))

vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children
  }: {
    value: string
    onValueChange: (value: string) => void
    disabled?: boolean
    children: React.ReactNode
  }) => (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  )
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('./date-picker-calendar', () => ({
  DatePickerCalendar: ({ onSelect }: { onSelect: (date: Date) => void }) => (
    <button type="button" onClick={() => onSelect(new Date('2026-06-01T00:00:00Z'))}>
      pick mocked date
    </button>
  )
}))

describe('CustomRepeatDialog', () => {
  it('edits weekly days, clamps inputs, saves count-ended config, and closes from dialog state', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    const onClose = vi.fn()

    render(
      <CustomRepeatDialog
        isOpen
        dueDate={new Date('2026-05-12T00:00:00Z')}
        onClose={onClose}
        onSave={onSave}
      />
    )

    await user.click(screen.getByRole('button', { name: /Tuesday, selected/ }))
    await user.click(screen.getByRole('button', { name: /^Sunday/ }))

    const intervalInput = screen.getByDisplayValue('1')
    fireEvent.change(intervalInput, { target: { value: '2' } })

    const afterRadio = screen.getByText('after').closest('label')?.querySelector('input')
    fireEvent.click(afterRadio as HTMLInputElement)
    const countInput = screen.getByDisplayValue('10')
    fireEvent.change(countInput, { target: { value: '3' } })

    await user.click(screen.getByRole('button', { name: 'save' }))

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        frequency: 'weekly',
        interval: 2,
        daysOfWeek: expect.arrayContaining([0, 2]),
        endType: 'count',
        endCount: 3
      })
    )
    expect(onClose).toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'mock dialog close' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('edits monthly week-pattern options and date-ended preview from an existing config', async () => {
    const onSave = vi.fn()
    const initialConfig: RepeatConfig = {
      frequency: 'monthly',
      interval: 1,
      monthlyType: 'dayOfMonth',
      dayOfMonth: 15,
      endType: 'date',
      endDate: new Date('2026-05-31T00:00:00Z'),
      completedCount: 2,
      createdAt: new Date('2026-05-01T00:00:00Z')
    }

    render(
      <CustomRepeatDialog
        isOpen
        dueDate={new Date('2026-05-15T00:00:00Z')}
        initialConfig={initialConfig}
        onClose={vi.fn()}
        onSave={onSave}
      />
    )

    fireEvent.click(screen.getByLabelText(/the/))
    const selects = screen.getAllByRole('combobox')
    fireEvent.change(selects[2], { target: { value: '5' } })
    fireEvent.change(selects[3], { target: { value: '1' } })

    await userEvent.click(screen.getByRole('button', { name: 'pick mocked date' }))
    await userEvent.click(screen.getByRole('button', { name: 'save' }))

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        frequency: 'monthly',
        monthlyType: 'weekPattern',
        weekOfMonth: 5,
        dayOfWeekForMonth: 1,
        endType: 'date',
        endDate: new Date('2026-06-01T00:00:00Z'),
        completedCount: 2
      })
    )
  })

  it('does not mount the form body while closed', () => {
    render(<CustomRepeatDialog isOpen={false} onClose={vi.fn()} onSave={vi.fn()} />)

    expect(screen.queryByText('frequency')).not.toBeInTheDocument()
  })
})
