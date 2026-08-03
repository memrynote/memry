import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedRelationRef } from '@memry/contracts/properties-api'
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

const mocks = vi.hoisted(() => ({
  resolveRefs: vi.fn()
}))

vi.mock('@/services/properties-service', () => ({
  propertiesService: {
    resolveRefs: mocks.resolveRefs
  }
}))

// Real i18n: tests/setup-dom.ts initializes the global i18next singleton with
// English resources, so useT('notes') resolves real strings (e.g. "Deleted")
// without a mock here. A blanket useT mock would also swallow TagChip's own
// interpolated "Remove tag: {tag}" aria-label used by the pre-existing test
// below.
function mockResolveRefs(refs: ResolvedRelationRef[]): void {
  mocks.resolveRefs.mockResolvedValue(refs)
}

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
})

describe('relation property cells', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders relation values as compact chips', async () => {
    mockResolveRefs([
      {
        uri: 'memry://note/nte_1',
        targetType: 'note',
        targetId: 'nte_1',
        title: 'Richard Doe',
        exists: true
      }
    ])
    render(<PropertyCell type="relation" value={['memry://note/nte_1']} />)
    expect(await screen.findByText('Richard Doe')).toBeInTheDocument()
  })

  it('does not offer editing affordances', async () => {
    mockResolveRefs([
      {
        uri: 'memry://note/nte_1',
        targetType: 'note',
        targetId: 'nte_1',
        title: 'Richard Doe',
        exists: true
      }
    ])
    render(<PropertyCell type="relation" value={['memry://note/nte_1']} />)
    expect(await screen.findByText('Richard Doe')).toBeInTheDocument()
    expect(screen.queryByLabelText('Add relation')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('does not offer editing affordances even when the cell is used editably', async () => {
    mockResolveRefs([
      {
        uri: 'memry://note/nte_1',
        targetType: 'note',
        targetId: 'nte_1',
        title: 'Richard Doe',
        exists: true
      }
    ])
    const onSave = vi.fn()
    render(<EditablePropertyCell type="relation" value={['memry://note/nte_1']} onSave={onSave} />)
    expect(await screen.findByText('Richard Doe')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()

    // There is nothing clickable to enter edit mode with, but assert the
    // no-write guarantee directly: clicking the chip text must never call
    // onSave.
    fireEvent.click(screen.getByText('Richard Doe'))
    expect(onSave).not.toHaveBeenCalled()
  })

  it('renders dangling refs in a distinct muted state', async () => {
    mockResolveRefs([
      {
        uri: 'memry://note/nte_gone',
        targetType: 'note',
        targetId: 'nte_gone',
        title: '',
        exists: false
      }
    ])
    render(<PropertyCell type="relation" value={['memry://note/nte_gone']} />)
    const chip = await screen.findByText('Deleted')
    expect(chip.parentElement).toHaveClass('bg-muted', 'text-muted-foreground')
  })

  it('renders an em dash for an empty relation value without resolving', () => {
    render(<PropertyCell type="relation" value={[]} />)
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(mocks.resolveRefs).not.toHaveBeenCalled()
  })

  it('batches concurrent relation cells on the same page into one resolveRefs call', async () => {
    mockResolveRefs([
      {
        uri: 'memry://note/nte_1',
        targetType: 'note',
        targetId: 'nte_1',
        title: 'Richard Doe',
        exists: true
      },
      {
        uri: 'memry://task/tsk_2',
        targetType: 'task',
        targetId: 'tsk_2',
        title: 'Call mom',
        exists: true
      }
    ])

    // Simulate a page of rows: many relation cells mounting in one commit,
    // the way a virtualized folder table renders its visible rows.
    render(
      <div>
        {Array.from({ length: 50 }, (_, i) => (
          <PropertyCell
            key={i}
            type="relation"
            value={[i % 2 === 0 ? 'memry://note/nte_1' : 'memry://task/tsk_2']}
          />
        ))}
      </div>
    )

    expect((await screen.findAllByText('Richard Doe')).length).toBeGreaterThan(0)
    expect((await screen.findAllByText('Call mom')).length).toBeGreaterThan(0)
    expect(mocks.resolveRefs).toHaveBeenCalledTimes(1)
    expect(mocks.resolveRefs).toHaveBeenCalledWith(
      expect.arrayContaining(['memry://note/nte_1', 'memry://task/tsk_2'])
    )
  })
})
