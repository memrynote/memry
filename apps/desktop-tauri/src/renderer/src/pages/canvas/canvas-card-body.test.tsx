import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CanvasCardBody } from './canvas-card-body'
import type { CanvasCardRef } from './canvas-cards'
import type { CanvasEntityState } from './use-canvas-entities'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      const last = key.split('.').at(-1) ?? key
      return vars ? `${last}:${Object.values(vars).join('/')}` : last
    }
  })
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

  it('renders a project as its name, description, progress and overdue count', () => {
    render(
      <CanvasCardBody
        cardRef={ref({ entityType: 'project', entityId: 'p1' })}
        state={{
          status: 'ready',
          kind: 'project',
          title: 'Launch',
          color: '#3366ff',
          description: 'Ship v2 to everyone',
          taskCount: 4,
          completedCount: 1,
          overdueCount: 2
        }}
        interactive={false}
      />
    )
    expect(screen.getByText('Launch')).toBeInTheDocument()
    expect(screen.getByText('Ship v2 to everyone')).toBeInTheDocument()
    expect(screen.getByText('doneOf:1/4')).toBeInTheDocument()
    expect(screen.getByText('25%')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25')
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('says a project has no tasks instead of drawing an empty bar', () => {
    render(
      <CanvasCardBody
        cardRef={ref({ entityType: 'project', entityId: 'p1' })}
        state={{
          status: 'ready',
          kind: 'project',
          title: 'Empty',
          color: '#3366ff',
          description: null,
          taskCount: 0,
          completedCount: 0,
          overdueCount: 0
        }}
        interactive={false}
      />
    )
    expect(screen.getByText('projectNoTasks')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('previews an image file from the vault and names its type, size and folder', () => {
    const { container } = render(
      <CanvasCardBody
        cardRef={ref({ entityType: 'file', entityId: 'f1' })}
        state={{
          status: 'ready',
          kind: 'file',
          title: 'Whiteboard',
          fileType: 'image',
          path: 'Meetings/Q3/Whiteboard.png',
          absolutePath: '/vault/Meetings/Q3/Whiteboard.png',
          fileSize: 2048
        }}
        interactive={false}
      />
    )
    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      'memry-file://local/vault/Meetings/Q3/Whiteboard.png'
    )
    expect(screen.getByText('Whiteboard')).toBeInTheDocument()
    expect(screen.getByText('PNG')).toBeInTheDocument()
    expect(screen.getByText('2 KB')).toBeInTheDocument()
    expect(screen.getByText('Meetings/Q3')).toBeInTheDocument()
  })

  it('shows a PDF by its type icon rather than loading it into the card', () => {
    const { container } = render(
      <CanvasCardBody
        cardRef={ref({ entityType: 'file', entityId: 'f1' })}
        state={{
          status: 'ready',
          kind: 'file',
          title: 'Brief',
          fileType: 'pdf',
          path: 'Brief.pdf',
          absolutePath: '/vault/Brief.pdf',
          fileSize: null
        }}
        interactive={false}
      />
    )
    expect(container.querySelector('img, video, iframe')).toBeNull()
    expect(screen.getByText('PDF')).toBeInTheDocument()
  })

  it('falls back to an empty body while the note is still loading', () => {
    render(<CanvasCardBody cardRef={ref()} state={{ status: 'loading' }} interactive={false} />)
    expect(screen.getByTestId('note-body-readonly')).toHaveTextContent('')
    expect(screen.getByText('untitled')).toBeInTheDocument()
  })
})
