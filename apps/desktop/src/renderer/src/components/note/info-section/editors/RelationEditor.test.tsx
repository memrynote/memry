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
  searchEvents: vi.fn(),
  openTab: vi.fn()
}))

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({ openTab: mocks.openTab })
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

  // The app strips the default focus ring globally
  // (`*:focus-visible { outline: none; }` in assets/main.css), so every
  // interactive element needs its own compensating focus-visible treatment
  // or a keyboard user tabbing to it sees nothing. jsdom does not compute
  // styles from Tailwind classes, so this asserts on the className carrying
  // a focus-visible: treatment as a proxy for the real visual indicator.
  it('gives the add trigger a visible focus-visible treatment', () => {
    renderWithI18n(<RelationEditor value={[]} onChange={vi.fn()} />)
    expect(screen.getByLabelText('Add relation').className).toMatch(/focus-visible:/)
  })

  // Same requirement for the chip remove buttons, which sit between the add
  // trigger and the rest of the row in tab order. Both chip states are checked:
  // they take different branches for their hover styling and could drift apart.
  it('gives chip remove buttons a visible focus-visible treatment', async () => {
    mockResolveRefs([
      {
        uri: 'memry://note/nte_1',
        targetType: 'note',
        targetId: 'nte_1',
        title: 'Richard Doe',
        exists: true
      },
      {
        uri: 'memry://note/nte_gone',
        targetType: 'note',
        targetId: 'nte_gone',
        title: '',
        exists: false
      }
    ])
    renderWithI18n(
      <RelationEditor value={['memry://note/nte_1', 'memry://note/nte_gone']} onChange={vi.fn()} />
    )

    expect((await screen.findByLabelText('Remove Richard Doe')).className).toMatch(/focus-visible:/)
    expect(screen.getByLabelText('Remove Deleted').className).toMatch(/focus-visible:/)
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

describe('RelationEditor — emoji and navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const ref = (over: Partial<ResolvedRelationRef>): ResolvedRelationRef => ({
    uri: 'memry://note/nte_1',
    targetType: 'note',
    targetId: 'nte_1',
    title: 'Richard Doe',
    exists: true,
    ...over
  })

  it("shows the note's own emoji instead of the kind icon", async () => {
    mockResolveRefs([ref({ emoji: '👩' })])
    renderWithI18n(<RelationEditor value={['memry://note/nte_1']} onChange={vi.fn()} />)
    expect(await screen.findByText('👩')).toBeInTheDocument()
  })

  it('opens a note tab, carrying the emoji onto the tab', async () => {
    mockResolveRefs([ref({ emoji: '👩' })])
    renderWithI18n(<RelationEditor value={['memry://note/nte_1']} onChange={vi.fn()} />)
    await userEvent.click(await screen.findByText('Richard Doe'))

    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'note', entityId: 'nte_1', emoji: '👩' })
    )
  })

  it('opens a file tab for a non-markdown target', async () => {
    mockResolveRefs([
      ref({
        uri: 'memry://note/nte_pdf',
        targetId: 'nte_pdf',
        title: 'contract.pdf',
        fileType: 'pdf'
      })
    ])
    renderWithI18n(<RelationEditor value={['memry://note/nte_pdf']} onChange={vi.fn()} />)
    await userEvent.click(await screen.findByText('contract.pdf'))

    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'file', entityId: 'nte_pdf' })
    )
  })

  it("opens the task's project scope and its detail drawer", async () => {
    mockResolveRefs([
      ref({
        uri: 'memry://task/tsk_1',
        targetType: 'task',
        targetId: 'tsk_1',
        title: 'Call Richard',
        projectId: 'project-1'
      })
    ])
    renderWithI18n(<RelationEditor value={['memry://task/tsk_1']} onChange={vi.fn()} />)
    await userEvent.click(await screen.findByText('Call Richard'))

    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tasks',
        viewState: { openTaskId: 'tsk_1', selectedProjectId: 'project-1' }
      })
    )
  })

  it('leaves the tasks list filter alone when the task has no project', async () => {
    mockResolveRefs([
      ref({
        uri: 'memry://task/tsk_2',
        targetType: 'task',
        targetId: 'tsk_2',
        title: 'Loose task'
      })
    ])
    renderWithI18n(<RelationEditor value={['memry://task/tsk_2']} onChange={vi.fn()} />)
    await userEvent.click(await screen.findByText('Loose task'))

    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ viewState: { openTaskId: 'tsk_2' } })
    )
  })

  it('sends the calendar the event date as well as the id, so it can move its range', async () => {
    mockResolveRefs([
      ref({
        uri: 'memry://event/evt_1',
        targetType: 'event',
        targetId: 'evt_1',
        title: 'Lunch',
        startAt: '2026-08-30T12:00:00.000Z'
      })
    ])
    renderWithI18n(<RelationEditor value={['memry://event/evt_1']} onChange={vi.fn()} />)
    await userEvent.click(await screen.findByText('Lunch'))

    const tab = mocks.openTab.mock.calls[0][0]
    expect(tab.type).toBe('calendar')
    expect(tab.viewState.focusCalendarEventId).toBe('evt_1')
    // The calendar's anchorDate is a local YYYY-MM-DD string, NOT an instant:
    // parseLocalDate splits on '-' and passes the parts to new Date(y, m, d),
    // so a full ISO timestamp produces NaN and the range memo throws
    // `RangeError: Invalid time value`, killing the tab. Midday UTC keeps this
    // assertion on the same local day in every real timezone.
    expect(tab.viewState.focusDate).toBe('2026-08-30')
    // Both calendar effects short-circuit on a consumed token, so a fresh one
    // is what makes a repeat click work at all.
    expect(typeof tab.viewState.focusedAt).toBe('number')
  })

  it('opens the calendar unfocused rather than crashing when the event has no usable date', async () => {
    mockResolveRefs([
      ref({
        uri: 'memry://event/evt_bad',
        targetType: 'event',
        targetId: 'evt_bad',
        title: 'Broken',
        startAt: 'not-a-date'
      })
    ])
    renderWithI18n(<RelationEditor value={['memry://event/evt_bad']} onChange={vi.fn()} />)
    await userEvent.click(await screen.findByText('Broken'))

    const tab = mocks.openTab.mock.calls[0][0]
    expect(tab.type).toBe('calendar')
    // No focusDate at all beats an unparseable one — the calendar's first
    // effect requires it, so it simply does not fire and the tab still opens.
    expect(tab.viewState.focusDate).toBeUndefined()
    expect(tab.viewState.focusCalendarEventId).toBe('evt_bad')
  })

  it('does not navigate from a deleted chip', async () => {
    mockResolveRefs([
      ref({ uri: 'memry://note/nte_gone', targetId: 'nte_gone', title: '', exists: false })
    ])
    renderWithI18n(<RelationEditor value={['memry://note/nte_gone']} onChange={vi.fn()} />)
    const chip = await screen.findByTestId('relation-chip-deleted')
    await userEvent.click(chip)

    expect(mocks.openTab).not.toHaveBeenCalled()
  })

  it('removes without navigating when the × is clicked', async () => {
    mockResolveRefs([ref({})])
    const onChange = vi.fn()
    renderWithI18n(<RelationEditor value={['memry://note/nte_1']} onChange={onChange} />)
    await userEvent.click(await screen.findByLabelText('Remove Richard Doe'))

    expect(onChange).toHaveBeenCalledWith([])
    expect(mocks.openTab).not.toHaveBeenCalled()
  })
})
