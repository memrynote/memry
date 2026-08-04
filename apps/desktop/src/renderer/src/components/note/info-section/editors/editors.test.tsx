import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CheckboxEditor } from './CheckboxEditor'
import { DateEditor } from './DateEditor'
import { LongTextEditor } from './LongTextEditor'
import { MultiselectEditor } from './MultiselectEditor'
import { NumberEditor } from './NumberEditor'
import { RatingEditor } from './RatingEditor'
import { SelectChip } from './SelectChip'
import { SelectEditor } from './SelectEditor'
import { StatusEditor } from './StatusEditor'
import { TextEditor } from './TextEditor'
import { UrlEditor } from './UrlEditor'

const mocks = vi.hoisted(() => ({
  pickerValueChange: null as null | ((value: string) => void)
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('@/components/ui/picker', () => {
  const PickerRoot = ({
    children,
    onValueChange
  }: {
    children: React.ReactNode
    onValueChange?: (value: string) => void
  }) => {
    mocks.pickerValueChange = onValueChange ?? null
    return <div>{children}</div>
  }

  return {
    Picker: Object.assign(PickerRoot, {
      Trigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
      Content: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      Search: ({ placeholder }: { placeholder?: string }) => (
        <input aria-label="picker-search" placeholder={placeholder} />
      ),
      List: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      Empty: ({ message }: { message: string }) => <p>{message}</p>,
      Item: ({
        label,
        value,
        trailing
      }: {
        label: string
        value: string
        trailing?: React.ReactNode
      }) => (
        <div>
          <button type="button" onClick={() => mocks.pickerValueChange?.(value)}>
            {label}
          </button>
          {trailing}
        </div>
      ),
      Separator: () => <hr />,
      Footer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      Section: ({ label, children }: { label: string; children: React.ReactNode }) => (
        <section aria-label={label}>
          <h3>{label}</h3>
          {children}
        </section>
      )
    })
  }
})

// DateEditor is self-managed via Radix Popover; mock it (like the picker) so its
// content renders in jsdom, and stub the settings hooks it reads.
vi.mock('@/hooks/use-date-format', () => ({ useDateFormat: () => 'DD.MM.YYYY' }))

vi.mock('@/hooks/use-calendar-preferences', () => ({
  useWeekStartsOn: () => 1
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverAnchor: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

const options = [
  { value: 'Todo', color: 'stone' },
  { value: 'Done', color: 'green' }
]

const categories = {
  todo: { label: 'Todo', options: [{ value: 'Backlog', color: 'stone' }] },
  in_progress: { label: 'Doing', options: [{ value: 'Working', color: 'blue' }] },
  done: { label: 'Done', options: [{ value: 'Shipped', color: 'green' }] }
}

describe('note info property editors', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.pickerValueChange = null
  })

  it('edits text, long text, numbers, dates, and urls through keyboard and blur paths', () => {
    const onTextChange = vi.fn()
    const onLongChange = vi.fn()
    const onNumberChange = vi.fn()
    const onDateChange = vi.fn()
    const onUrlChange = vi.fn()
    const onBlur = vi.fn()

    const { rerender } = render(
      <TextEditor value="old" onChange={onTextChange} onBlur={onBlur} autoFocus={false} />
    )
    fireEvent.change(screen.getByDisplayValue('old'), { target: { value: 'new' } })
    fireEvent.keyDown(screen.getByDisplayValue('new'), { key: 'Enter' })
    expect(onTextChange).toHaveBeenCalledWith('new')

    rerender(
      <LongTextEditor value="body" onChange={onLongChange} onBlur={onBlur} autoFocus={false} />
    )
    fireEvent.change(screen.getByDisplayValue('body'), { target: { value: 'long body' } })
    fireEvent.keyDown(screen.getByDisplayValue('long body'), { key: 'Enter', metaKey: true })
    expect(onLongChange).toHaveBeenCalledWith('long body')
    fireEvent.keyDown(screen.getByDisplayValue('long body'), { key: 'Escape' })

    rerender(<NumberEditor value={3} onChange={onNumberChange} onBlur={onBlur} autoFocus={false} />)
    const numberInput = screen.getByDisplayValue('3')
    const invalidKey = new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true })
    numberInput.dispatchEvent(invalidKey)
    expect(invalidKey.defaultPrevented).toBe(true)
    fireEvent.change(numberInput, { target: { value: '-4.5' } })
    fireEvent.blur(numberInput)
    expect(onNumberChange).toHaveBeenCalledWith(-4.5)

    rerender(<DateEditor value={null} onChange={onDateChange} defaultOpen />)
    const dateInput = screen.getByPlaceholderText('DD.MM.YYYY')
    fireEvent.change(dateInput, { target: { value: '31.02.2026' } })
    fireEvent.keyDown(dateInput, { key: 'Enter' })
    expect(onDateChange).not.toHaveBeenCalled()
    fireEvent.change(dateInput, { target: { value: '10.05.2026' } })
    fireEvent.keyDown(dateInput, { key: 'Enter' })
    expect(onDateChange.mock.calls.at(-1)?.[0]).toEqual(new Date(2026, 4, 10))

    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    rerender(
      <UrlEditor
        value="https://memrynote.com"
        onChange={onUrlChange}
        onBlur={onBlur}
        autoFocus={false}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'properties.openUrlAria' }))
    expect(open).toHaveBeenCalledWith('https://memrynote.com', '_blank', 'noopener,noreferrer')
    fireEvent.change(screen.getByDisplayValue('https://memrynote.com'), {
      target: { value: 'not-a-url' }
    })
    fireEvent.blur(screen.getByDisplayValue('not-a-url'))
    expect(onUrlChange).not.toHaveBeenCalledWith('not-a-url')
    open.mockRestore()
  })

  it('toggles checkbox and rating values with mouse and keyboard', () => {
    const onCheck = vi.fn()
    const onRating = vi.fn()

    render(<CheckboxEditor value={false} onChange={onCheck} />)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.keyDown(screen.getByRole('checkbox'), { key: ' ' })
    expect(onCheck).toHaveBeenCalledWith(true)

    const { rerender } = render(<RatingEditor value={2} onChange={onRating} />)
    const stars = screen.getAllByRole('button')
    fireEvent.mouseEnter(stars[3])
    fireEvent.click(stars[1])
    expect(onRating).toHaveBeenCalledWith(0)
    fireEvent.keyDown(stars[1], { key: 'ArrowRight' })
    expect(onRating).toHaveBeenCalledWith(3)

    rerender(<RatingEditor value={0} onChange={onRating} maxRating={3} />)
    fireEvent.keyDown(screen.getAllByRole('button')[0], { key: 'Enter' })
    expect(onRating).toHaveBeenCalledWith(1)
  })

  it('renders chips and drives select and multiselect option flows', () => {
    const onSelectChange = vi.fn()
    const onMultiChange = vi.fn()
    const onAdd = vi.fn()
    const onRemove = vi.fn()

    const { container, rerender } = render(
      <SelectChip value="Clickable" color="green" onClick={onSelectChange} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Clickable' }))
    expect(onSelectChange).toHaveBeenCalledTimes(1)

    rerender(
      <SelectEditor
        value="Todo"
        options={options}
        defaultOpen
        onChange={onSelectChange}
        onAddOption={onAdd}
        onRemoveOption={onRemove}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onSelectChange).toHaveBeenCalledWith('Done')

    fireEvent.click(screen.getByRole('button', { name: 'properties.newOption' }))
    fireEvent.change(screen.getByPlaceholderText('properties.optionName'), {
      target: { value: 'Later' }
    })
    fireEvent.keyDown(screen.getByPlaceholderText('properties.optionName'), { key: 'Enter' })
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ value: 'Later' }))
    expect(onSelectChange).toHaveBeenCalledWith('Later')

    const removeButtons = container.querySelectorAll('button')
    fireEvent.click(removeButtons[removeButtons.length - 2])
    expect(onRemove).toHaveBeenCalled()

    rerender(
      <MultiselectEditor
        value={['Todo', 'Unknown']}
        options={options}
        defaultOpen
        onChange={onMultiChange}
        onAddOption={onAdd}
        onRemoveOption={onRemove}
      />
    )
    expect(screen.getByText('Unknown')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onMultiChange).toHaveBeenCalledWith(['Todo', 'Unknown', 'Done'])
    fireEvent.click(screen.getByRole('button', { name: 'properties.newOption' }))
    fireEvent.change(screen.getByPlaceholderText('properties.optionName'), {
      target: { value: 'Soon' }
    })
    fireEvent.keyDown(screen.getByPlaceholderText('properties.optionName'), { key: 'Enter' })
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ value: 'Soon' }))
    expect(onMultiChange).toHaveBeenCalledWith(['Todo', 'Unknown', 'Soon'])
  })

  it('drives status categories, selection, creation, removal, and orphan display', () => {
    const onChange = vi.fn()
    const onAdd = vi.fn()
    const onRemove = vi.fn()

    const { container, rerender } = render(
      <StatusEditor
        value="Missing"
        categories={categories}
        defaultOpen
        onChange={onChange}
        onAddOption={onAdd}
        onRemoveOption={onRemove}
      />
    )

    expect(screen.getByText('Missing')).toBeInTheDocument()
    // Section headers are built-in status categories, so StatusEditor renders the
    // translated category name (via getStatusCategoryLabel + the real i18n
    // singleton) rather than the English fallback label on the fixture. Option
    // values inside the sections stay user data and still render verbatim.
    fireEvent.click(
      within(screen.getByRole('region', { name: 'In progress' })).getByText('Working')
    )
    expect(onChange).toHaveBeenCalledWith('Working')

    fireEvent.click(within(screen.getByRole('region', { name: 'To-do' })).getByText('button.add'))
    fireEvent.change(screen.getByPlaceholderText('properties.optionName'), {
      target: { value: 'Next' }
    })
    fireEvent.keyDown(screen.getByPlaceholderText('properties.optionName'), { key: 'Enter' })
    expect(onAdd).toHaveBeenCalledWith('todo', expect.objectContaining({ value: 'Next' }))
    expect(onChange).toHaveBeenCalledWith('Next')

    const removeButtons = container.querySelectorAll('section button')
    fireEvent.click(removeButtons[1])
    expect(onRemove).toHaveBeenCalled()

    rerender(<StatusEditor value={null} categories={categories} onChange={onChange} />)
    expect(screen.getByText('properties.empty')).toBeInTheDocument()
  })
})
