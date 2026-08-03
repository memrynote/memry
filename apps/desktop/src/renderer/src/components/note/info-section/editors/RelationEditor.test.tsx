import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { RelationEditor } from './RelationEditor'
import type { ResolvedRelationRef } from '@memry/contracts/properties-api'

const mocks = vi.hoisted(() => ({
  resolveRefs: vi.fn(),
  quick: vi.fn(),
  searchEvents: vi.fn()
}))

vi.mock('@/services/properties-service', () => ({
  propertiesService: {
    resolveRefs: mocks.resolveRefs
  }
}))

vi.mock('@/services/search-service', () => ({
  searchService: { quick: (...args: unknown[]) => mocks.quick(...args) }
}))
vi.mock('@/services/calendar-service', () => ({
  calendarService: { searchEvents: (input: unknown) => mocks.searchEvents(input) }
}))

// The real Radix Popover does not open on click in jsdom. Stub the wrapper so
// the trigger click flips `onOpenChange(true)` and the content renders only
// when open — same convention as icon-picker-button.test.tsx.
vi.mock('@/components/ui/popover', async () => {
  const React = await import('react')
  return {
    Popover: ({ open, onOpenChange, children }: any) =>
      React.createElement(
        React.Fragment,
        null,
        React.Children.map(children, (child: any) =>
          React.isValidElement(child) ? React.cloneElement(child, { open, onOpenChange }) : child
        )
      ),
    PopoverTrigger: ({ children, onOpenChange }: any) =>
      React.cloneElement(children, {
        onClick: (e: any) => {
          children.props.onClick?.(e)
          onOpenChange?.(true)
        }
      }),
    PopoverContent: ({ children, open }: any) =>
      open ? React.createElement('div', null, children) : null
  }
})

let i18nEn: I18nInstance

beforeAll(async () => {
  i18nEn = await createRendererI18n({ locale: 'en' })
})

const renderWithI18n = (ui: React.ReactElement) =>
  render(<I18nextProvider i18n={i18nEn}>{ui}</I18nextProvider>)

function mockResolveRefs(refs: ResolvedRelationRef[]): void {
  mocks.resolveRefs.mockResolvedValue(refs)
}

describe('RelationEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders one chip per resolved ref', async () => {
    mockResolveRefs([
      {
        uri: 'memry://note/nte_1',
        targetType: 'note',
        targetId: 'nte_1',
        title: 'Richard Doe',
        exists: true
      }
    ])
    renderWithI18n(<RelationEditor value={['memry://note/nte_1']} onChange={vi.fn()} />)
    expect(await screen.findByText('Richard Doe')).toBeInTheDocument()
    expect(mocks.resolveRefs).toHaveBeenCalledWith(['memry://note/nte_1'])
  })

  it('renders a deleted chip for a missing target and keeps the value', async () => {
    mockResolveRefs([
      {
        uri: 'memry://note/nte_gone',
        targetType: 'note',
        targetId: 'nte_gone',
        title: '',
        exists: false
      }
    ])
    const onChange = vi.fn()
    renderWithI18n(<RelationEditor value={['memry://note/nte_gone']} onChange={onChange} />)
    expect(await screen.findByTestId('relation-chip-deleted')).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('removes a chip through onChange without mutating the input array', async () => {
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
        title: 'Call',
        exists: true
      }
    ])
    const value = ['memry://note/nte_1', 'memry://task/tsk_2']
    const onChange = vi.fn()
    renderWithI18n(<RelationEditor value={value} onChange={onChange} />)
    await userEvent.click(await screen.findByLabelText('Remove Richard Doe'))
    expect(onChange).toHaveBeenCalledWith(['memry://task/tsk_2'])
    expect(value).toEqual(['memry://note/nte_1', 'memry://task/tsk_2'])
  })

  it('renders nothing but stays mounted for an empty value', () => {
    const { container } = renderWithI18n(<RelationEditor value={[]} onChange={vi.fn()} />)
    expect(screen.queryByTestId('relation-chip')).not.toBeInTheDocument()
    expect(mocks.resolveRefs).not.toHaveBeenCalled()
    expect(container).toBeInTheDocument()
  })

  it('re-resolves when value changes', async () => {
    mockResolveRefs([
      {
        uri: 'memry://note/nte_1',
        targetType: 'note',
        targetId: 'nte_1',
        title: 'Richard Doe',
        exists: true
      }
    ])
    const { rerender } = renderWithI18n(
      <RelationEditor value={['memry://note/nte_1']} onChange={vi.fn()} />
    )
    expect(await screen.findByText('Richard Doe')).toBeInTheDocument()

    mockResolveRefs([
      {
        uri: 'memry://task/tsk_2',
        targetType: 'task',
        targetId: 'tsk_2',
        title: 'Call',
        exists: true
      }
    ])
    rerender(
      <I18nextProvider i18n={i18nEn}>
        <RelationEditor value={['memry://task/tsk_2']} onChange={vi.fn()} />
      </I18nextProvider>
    )
    expect(await screen.findByText('Call')).toBeInTheDocument()
  })

  it('renders an add trigger even for an empty value', () => {
    renderWithI18n(<RelationEditor value={[]} onChange={vi.fn()} />)
    expect(screen.getByLabelText('Add relation')).toBeInTheDocument()
  })

  it('does not add a duplicate URI', async () => {
    mockResolveRefs([
      {
        uri: 'memry://note/nte_1',
        targetType: 'note',
        targetId: 'nte_1',
        title: 'Richard Doe',
        exists: true
      }
    ])
    mocks.quick.mockResolvedValue({
      results: [
        {
          id: 'nte_1',
          type: 'note',
          title: 'Richard Doe',
          snippet: '',
          score: 1,
          normalizedScore: 1,
          matchType: 'fuzzy',
          modifiedAt: '2026-01-01T00:00:00.000Z',
          metadata: { type: 'note', path: '/nte_1.md', tags: [] }
        }
      ],
      queryTimeMs: 1
    })
    mocks.searchEvents.mockResolvedValue({ events: [] })

    const onChange = vi.fn()
    renderWithI18n(<RelationEditor value={['memry://note/nte_1']} onChange={onChange} />)
    expect(await screen.findByText('Richard Doe')).toBeInTheDocument()

    await userEvent.click(screen.getByLabelText('Add relation'))
    await userEvent.type(screen.getByRole('textbox'), 'rich')
    // "Richard Doe" is now on screen twice: the resolved chip and the picker
    // result row. Wait for the result row specifically — it is the only one
    // with role="option" — rather than the first text match, which would be
    // the pre-existing chip and would resolve before the debounced search
    // ever lands.
    const resultOption = await screen.findByRole('option', { name: 'Richard Doe' })
    await userEvent.click(resultOption)

    expect(onChange).not.toHaveBeenCalled()
  })
})
