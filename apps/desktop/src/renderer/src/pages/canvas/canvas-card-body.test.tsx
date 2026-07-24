import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CanvasCardBody } from './canvas-card-body'
import type { CanvasCardRef } from './canvas-cards'
import type { CanvasEntityState } from './use-canvas-entities'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) ?? key })
}))

// Stub the leaves: this test is about which body an entity type gets and how
// `interactive` is plumbed, not about the editors themselves (each has its own
// suite, and BlockNote/react-pdf must stay out of this module graph).
vi.mock('./canvas-note-body', () => ({
  CanvasNoteBody: ({ markdown }: { markdown: string }) => (
    <div data-testid="note-body-readonly">{markdown}</div>
  )
}))
vi.mock('./embedded-note-editor', () => ({
  EmbeddedNoteEditor: ({ noteId }: { noteId: string }) => (
    <div data-testid="note-editor">{noteId}</div>
  )
}))
vi.mock('./canvas-task-editor', () => ({
  CanvasTaskEditor: ({ taskId, interactive }: { taskId: string; interactive?: boolean }) => (
    <div data-testid="task-editor" data-interactive={String(interactive)}>
      {taskId}
    </div>
  )
}))
vi.mock('./canvas-event-editor', () => ({
  CanvasEventEditor: ({ eventId, interactive }: { eventId: string; interactive?: boolean }) => (
    <div data-testid="event-editor" data-interactive={String(interactive)}>
      {eventId}
    </div>
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
  body: '# Heading'
}

describe('CanvasCardBody', () => {
  it('renders the read-only note body when idle and the real editor when interactive', () => {
    const { rerender } = render(
      <CanvasCardBody cardRef={ref()} state={noteState} interactive={false} />
    )
    expect(screen.getByTestId('note-body-readonly')).toHaveTextContent('# Heading')
    expect(screen.queryByTestId('note-editor')).not.toBeInTheDocument()

    rerender(<CanvasCardBody cardRef={ref()} state={noteState} interactive />)
    expect(screen.getByTestId('note-editor')).toHaveTextContent('n1')
    expect(screen.queryByTestId('note-body-readonly')).not.toBeInTheDocument()
  })

  it('keeps the note title visible in BOTH states, so activation never drops it', () => {
    const { rerender } = render(
      <CanvasCardBody cardRef={ref()} state={noteState} interactive={false} />
    )
    expect(screen.getByText('My Note')).toBeInTheDocument()

    rerender(<CanvasCardBody cardRef={ref()} state={noteState} interactive />)
    expect(screen.getByText('My Note')).toBeInTheDocument()
  })

  it('mounts the SAME task editor in both states, only toggling interactivity', () => {
    const cardRef = ref({ entityType: 'task', entityId: 't1' })
    const { rerender } = render(
      <CanvasCardBody cardRef={cardRef} state={undefined} interactive={false} />
    )
    expect(screen.getByTestId('task-editor')).toHaveAttribute('data-interactive', 'false')

    rerender(<CanvasCardBody cardRef={cardRef} state={undefined} interactive />)
    expect(screen.getByTestId('task-editor')).toHaveAttribute('data-interactive', 'true')
  })

  it('mounts the SAME event editor in both states, only toggling interactivity', () => {
    const cardRef = ref({ entityType: 'calendar_event', entityId: 'ev1' })
    const { rerender } = render(
      <CanvasCardBody cardRef={cardRef} state={undefined} interactive={false} />
    )
    expect(screen.getByTestId('event-editor')).toHaveAttribute('data-interactive', 'false')

    rerender(<CanvasCardBody cardRef={cardRef} state={undefined} interactive />)
    expect(screen.getByTestId('event-editor')).toHaveAttribute('data-interactive', 'true')
  })

  it('insets the note body identically in both states, so text never touches the border', () => {
    // The global `:root .bn-editor { padding-inline: 0 }` rule leaves note prose
    // flush against the card's rounded border. The inset lives on this shared
    // wrapper — one place for both states, so activation cannot reflow the text.
    const { container, rerender } = render(
      <CanvasCardBody cardRef={ref()} state={noteState} interactive={false} />
    )
    const idle = container.querySelector('[data-canvas-note-content]')
    expect(idle).not.toBeNull()
    const idleClass = idle!.className

    rerender(<CanvasCardBody cardRef={ref()} state={noteState} interactive />)
    const active = container.querySelector('[data-canvas-note-content]')
    expect(active).not.toBeNull()
    expect(active!.className).toBe(idleClass)
    expect(idleClass).toContain('px-3')
    expect(idleClass).toContain('pb-3')
  })

  it('falls back to an empty body while the note is still loading', () => {
    render(<CanvasCardBody cardRef={ref()} state={{ status: 'loading' }} interactive={false} />)
    expect(screen.getByTestId('note-body-readonly')).toHaveTextContent('')
    expect(screen.getByText('untitled')).toBeInTheDocument()
  })
})
