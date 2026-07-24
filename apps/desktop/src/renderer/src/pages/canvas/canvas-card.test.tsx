import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CanvasCard } from './canvas-card'
import type { CanvasCardRef } from './canvas-cards'
import type { CanvasEntityState } from './use-canvas-entities'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) ?? key })
}))

// Render the note body as its raw text so the summary test doesn't depend on
// the marked token walker's internals (covered by its own tests).
vi.mock('@/components/tasks/task-description-preview', () => ({
  renderTaskDescriptionMarkdown: (md: string) => [md]
}))

// The full-fidelity body has its own suite; here it is a marker so the shell's
// concerns (chrome, LOD switch, inert clipping) can be asserted without pulling
// BlockNote and the task/calendar query stacks into this module graph.
vi.mock('./canvas-card-body', () => ({
  CanvasCardBody: ({ interactive }: { interactive: boolean }) => (
    <div data-testid="card-body" data-interactive={String(interactive)} />
  )
}))

function ref(overrides: Partial<CanvasCardRef> = {}): CanvasCardRef {
  return {
    elementId: 'e1',
    entityType: 'note',
    entityId: 'n1',
    x: 0,
    y: 0,
    width: 260,
    height: 168,
    angle: 0,
    ...overrides
  }
}

const noteState: CanvasEntityState = {
  status: 'ready',
  kind: 'note',
  title: 'My Note',
  emoji: null,
  body: 'the body text'
}

describe('CanvasCard', () => {
  it('renders the entity at full fidelity, read-only, and stamps entity attributes', () => {
    render(<CanvasCard cardRef={ref()} state={noteState} onRedirect={vi.fn()} />)

    expect(screen.getByTestId('card-body')).toHaveAttribute('data-interactive', 'false')
    const root = document.querySelector('[data-canvas-card-id="e1"]')
    expect(root?.getAttribute('data-canvas-card-entity')).toBe('note:n1')
    expect(root?.getAttribute('data-canvas-card-state')).toBe('ready')
  })

  it('clips the body in an inert scroll container the wheel handler can drive', () => {
    render(<CanvasCard cardRef={ref()} state={noteState} onRedirect={vi.fn()} />)

    const scroller = document.querySelector('[data-canvas-card-scroll="e1"]')
    expect(scroller).not.toBeNull()
    expect(scroller).toHaveAttribute('inert')
    expect(scroller?.className).toContain('overflow-hidden')
  })

  it('drops to the cheap summary render in level-of-detail fallback', () => {
    render(<CanvasCard cardRef={ref()} state={noteState} onRedirect={vi.fn()} rich={false} />)

    expect(screen.queryByTestId('card-body')).not.toBeInTheDocument()
    expect(screen.getByText('My Note')).toBeInTheDocument()
    expect(screen.getByText('the body text')).toBeInTheDocument()
  })

  it('summarizes a completed task with a strike-through title and due date', () => {
    const state: CanvasEntityState = {
      status: 'ready',
      kind: 'task',
      title: 'Do it',
      completed: true,
      dueDate: '2026-07-20'
    }
    render(
      <CanvasCard
        cardRef={ref({ entityType: 'task', entityId: 't1' })}
        state={state}
        onRedirect={vi.fn()}
        rich={false}
      />
    )
    expect(screen.getByText('Do it').className).toContain('line-through')
    expect(screen.getByText(/20|Jul/)).toBeInTheDocument()
  })

  it('summarizes a calendar event with its time', () => {
    const state: CanvasEntityState = {
      status: 'ready',
      kind: 'calendar_event',
      title: 'Standup',
      startAt: '2026-07-20T09:30:00.000Z',
      endAt: null,
      isAllDay: false
    }
    render(
      <CanvasCard
        cardRef={ref({ entityType: 'calendar_event', entityId: 'ev1' })}
        state={state}
        onRedirect={vi.fn()}
        rich={false}
      />
    )
    expect(screen.getByText('Standup')).toBeInTheDocument()
  })

  it('renders a dangling state for deleted entities', () => {
    render(<CanvasCard cardRef={ref()} state={{ status: 'dangling' }} onRedirect={vi.fn()} />)
    expect(screen.getByText('deleted')).toBeInTheDocument()
    expect(screen.queryByTestId('card-body')).not.toBeInTheDocument()
    expect(document.querySelector('[data-canvas-card-state="dangling"]')).not.toBeNull()
  })

  it('renders a loading state when the entity is not yet resolved', () => {
    render(<CanvasCard cardRef={ref()} state={undefined} onRedirect={vi.fn()} />)
    expect(screen.getByText('loading')).toBeInTheDocument()
    expect(screen.queryByTestId('card-body')).not.toBeInTheDocument()
    expect(document.querySelector('[data-canvas-card-state="loading"]')).not.toBeNull()
  })

  it('fires onRedirect (and stops propagation) when the ↗ button is clicked', () => {
    const onRedirect = vi.fn()
    const cardRef = ref()
    render(<CanvasCard cardRef={cardRef} state={noteState} onRedirect={onRedirect} />)
    fireEvent.click(screen.getByRole('button', { name: 'open' }))
    expect(onRedirect).toHaveBeenCalledWith(cardRef)
  })

  it('marks a locked card and offers open-in-tab-to-edit', () => {
    const onRedirect = vi.fn()
    const cardRef = ref()
    render(
      <CanvasCard
        cardRef={cardRef}
        state={noteState}
        onRedirect={onRedirect}
        locked="note-open-in-tab"
      />
    )

    const root = document.querySelector('[data-canvas-card-id="e1"]')
    expect(root).toHaveAttribute('data-canvas-card-locked', 'true')
    // A locked card still shows its content in full — only editing is refused.
    expect(screen.getByTestId('card-body')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'openToEdit' }))
    expect(onRedirect).toHaveBeenCalledWith(cardRef)
  })

  it('does not mark or gate an unlocked card', () => {
    render(<CanvasCard cardRef={ref()} state={noteState} onRedirect={vi.fn()} />)

    const root = document.querySelector('[data-canvas-card-id="e1"]')
    expect(root).not.toHaveAttribute('data-canvas-card-locked')
    expect(screen.queryByRole('button', { name: 'openToEdit' })).not.toBeInTheDocument()
  })
})
