import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  EditablePropertyCell,
  FolderCell,
  MultiSelectCell,
  PropertyCell,
  RatingCell,
  TagsCell,
  TitleCell,
  UrlCell,
  WordCountCell
} from './property-cell'

vi.mock('@/components/note/info-section/editors', () => ({
  TextEditor: ({ value, onChange, onBlur }: any) => (
    <input
      aria-label="text-editor"
      defaultValue={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      onBlur={onBlur}
    />
  ),
  NumberEditor: ({ value, onChange, onBlur }: any) => (
    <input
      aria-label="number-editor"
      defaultValue={value ?? ''}
      onChange={(event) => onChange(Number(event.currentTarget.value))}
      onBlur={onBlur}
    />
  ),
  CheckboxEditor: ({ value, onChange }: any) => (
    <button type="button" onClick={() => onChange(!value)}>
      checkbox-editor
    </button>
  ),
  DateEditor: ({ onChange, onBlur }: any) => (
    <button
      type="button"
      onClick={() => onChange(new Date('2026-01-02T00:00:00.000Z'))}
      onBlur={onBlur}
    >
      date-editor
    </button>
  ),
  UrlEditor: ({ value, onChange, onBlur }: any) => (
    <input
      aria-label="url-editor"
      defaultValue={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      onBlur={onBlur}
    />
  )
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/lib/render-note-icon', () => ({
  NoteIconDisplay: ({ value }: { value: string }) => <span>{value}</span>
}))

describe('folder-view property cells', () => {
  it('renders generic values for supported property types', () => {
    const { rerender } = render(<PropertyCell value={null} type="text" />)
    expect(screen.getByText('—')).toBeInTheDocument()

    rerender(<PropertyCell value="Hello world" type="text" highlightQuery="world" />)
    expect(screen.getByText('world')).toBeInTheDocument()

    rerender(<PropertyCell value="1234" type="number" />)
    expect(screen.getByText('1,234')).toBeInTheDocument()

    rerender(<PropertyCell value="2026-01-02T03:04:05.000Z" type="date" />)
    expect(screen.getByText(/02.01.2026/)).toBeInTheDocument()

    rerender(<PropertyCell value="Doing" type="select" />)
    expect(screen.getByText('Doing')).toBeInTheDocument()

    rerender(<PropertyCell value={['a', 'b', 'c', 'd']} type="multiselect" />)
    expect(screen.getByText('+1')).toBeInTheDocument()

    rerender(<PropertyCell value="https://example.com/docs" type="url" />)
    expect(screen.getByRole('link', { name: /^example\.com\/docs$/ })).toHaveAttribute(
      'href',
      'https://example.com/docs'
    )

    rerender(<PropertyCell value={3} type="rating" />)
    expect(screen.getByTitle('3/5')).toHaveTextContent('★★★☆☆')
  })

  it('renders specialized title, folder, tags, URL, rating, and word count cells', () => {
    const onOpen = vi.fn()
    const onFolder = vi.fn()
    const onTag = vi.fn()
    const onRemove = vi.fn()

    render(
      <div>
        <TitleCell title="Launch plan" emoji="*" onClick={onOpen} highlightQuery="plan" />
        <FolderCell path="Work/Plans" onClick={onFolder} />
        <TagsCell tags={['work', 'urgent']} onTagClick={onTag} onTagRemove={onRemove} />
        <UrlCell value="not a url" />
        <RatingCell value={9} max={5} />
        <WordCountCell value={1200} />
      </div>
    )

    fireEvent.click(screen.getByRole('button', { name: /Launch plan/ }))
    expect(onOpen).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: new RegExp('Work/Plans') }))
    expect(onFolder).toHaveBeenCalled()

    fireEvent.click(screen.getByText('work'))
    expect(onTag).toHaveBeenCalledWith('work')
    const urgentPill = screen.getByText('urgent').closest('button')
    fireEvent.mouseEnter(urgentPill as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: 'Remove tag: urgent' }))
    expect(onRemove).toHaveBeenCalledWith('urgent')

    expect(screen.getByRole('link', { name: /not a url/ })).toHaveAttribute('href', 'not a url')
    expect(screen.getByTitle('5/5')).toHaveTextContent('★★★★★')
    expect(screen.getByText('1,200')).toBeInTheDocument()
  })

  it('edits values only when the committed value changes', () => {
    const onSave = vi.fn()
    const { rerender } = render(<EditablePropertyCell value="old" type="text" onSave={onSave} />)

    fireEvent.click(screen.getByRole('button', { name: 'old' }))
    fireEvent.change(screen.getByLabelText('text-editor'), { target: { value: 'new' } })
    expect(onSave).toHaveBeenCalledWith('new')

    rerender(<EditablePropertyCell key="number" value={2} type="number" onSave={onSave} />)
    fireEvent.click(screen.getByRole('button', { name: '2' }))
    fireEvent.change(screen.getByLabelText('number-editor'), { target: { value: '5' } })
    expect(onSave).toHaveBeenCalledWith(5)

    rerender(<EditablePropertyCell key="checkbox" value={false} type="checkbox" onSave={onSave} />)
    fireEvent.click(screen.getByRole('button', { name: 'checkbox-editor' }))
    expect(onSave).toHaveBeenCalledWith(true)

    rerender(
      <EditablePropertyCell key="multiselect" value={['a']} type="multiselect" onSave={onSave} />
    )
    fireEvent.click(screen.getByRole('button', { name: /a/ }))
    fireEvent.change(screen.getByLabelText('text-editor'), { target: { value: 'a, b' } })
    expect(onSave).toHaveBeenCalledWith(['a', 'b'])

    const calls = onSave.mock.calls.length
    rerender(<EditablePropertyCell key="same" value="same" type="text" onSave={onSave} />)
    fireEvent.click(screen.getByRole('button', { name: 'same' }))
    fireEvent.change(screen.getByLabelText('text-editor'), { target: { value: 'same' } })
    expect(onSave).toHaveBeenCalledTimes(calls)
  })

  it('handles empty multiselect and root folder placeholders', () => {
    render(
      <div>
        <MultiSelectCell values={[]} />
        <FolderCell path="/" />
        <TagsCell tags={[]} />
      </div>
    )

    expect(screen.getAllByText('—')).toHaveLength(3)
  })

  it('renders project property values as chips, not the raw JSON array', () => {
    // Regression test: the `project` property's value is a string[] of project
    // names. Before this fix, PropertyType had no 'project' member so the
    // display switch fell through to the text default, which JSON-stringified
    // the array (e.g. literal `["Reading"]` text in the cell).
    const { rerender } = render(<PropertyCell value={['Reading']} type="project" />)
    expect(screen.getByText('Reading')).toBeInTheDocument()
    expect(screen.queryByText('["Reading"]')).not.toBeInTheDocument()

    rerender(<PropertyCell value={['Reading', 'Fitness 2026', 'Side Projects']} type="project" />)
    expect(screen.getByText('Reading')).toBeInTheDocument()
    expect(screen.getByText('Fitness 2026')).toBeInTheDocument()
    expect(screen.getByText('Side Projects')).toBeInTheDocument()
    expect(screen.queryByText('["Reading","Fitness 2026","Side Projects"]')).not.toBeInTheDocument()

    rerender(<PropertyCell value={[]} type="project" />)
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText('[]')).not.toBeInTheDocument()
  })

  it('commits project edits as an array, not a joined string', () => {
    // Regression test for the second (edit-mode) switch: without a 'project'
    // case it fell to the plain TextEditor default, which would commit a
    // single comma-joined string and silently change the property's stored
    // type from string[] to string.
    const onSave = vi.fn()
    render(<EditablePropertyCell value={['Reading']} type="project" onSave={onSave} />)

    fireEvent.click(screen.getByRole('button', { name: /Reading/ }))
    fireEvent.change(screen.getByLabelText('text-editor'), {
      target: { value: 'Reading, Fitness 2026' }
    })
    expect(onSave).toHaveBeenCalledWith(['Reading', 'Fitness 2026'])
  })
})
