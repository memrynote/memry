import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CanvasCardActive } from './canvas-card-active'
import type { CanvasCardRef } from './canvas-cards'

// Stub the per-type editor leaves so this test exercises only the container's
// own concerns: data attributes, focus-on-mount, and keyboard containment
// (canvas-card-overlay.test.tsx already covers the note branch via a real
// mount through the overlay; these stubs let us hit the task/event branches
// too without pulling BlockNote/react-pdf or the task/calendar query stacks).
vi.mock('./embedded-note-editor', () => ({
  EmbeddedNoteEditor: ({ noteId }: { noteId: string }) => (
    <div data-testid="embedded-note-editor">{noteId}</div>
  )
}))
vi.mock('./canvas-task-editor', () => ({
  CanvasTaskEditor: ({ taskId }: { taskId: string }) => (
    <div data-testid="canvas-task-editor">{taskId}</div>
  )
}))
vi.mock('./canvas-event-editor', () => ({
  CanvasEventEditor: ({ eventId, onDone }: { eventId: string; onDone: () => void }) => (
    <button data-testid="canvas-event-editor" onClick={onDone}>
      {eventId}
    </button>
  )
}))

function cardRef(entityType: CanvasCardRef['entityType'], entityId: string): CanvasCardRef {
  return {
    elementId: 'e1',
    entityType,
    entityId,
    x: 0,
    y: 0,
    width: 260,
    height: 168,
    angle: 0
  }
}

describe('CanvasCardActive', () => {
  it('renders the note editor for a note card and sets its data attributes', () => {
    render(
      <CanvasCardActive cardRef={cardRef('note', 'n1')} state={undefined} onDeactivate={vi.fn()} />
    )
    expect(screen.getByTestId('embedded-note-editor')).toHaveTextContent('n1')
    const root = document.querySelector('[data-canvas-active-card="e1"]')
    expect(root).toHaveAttribute('data-canvas-card-id', 'e1')
    expect(root).toHaveAttribute('data-canvas-card-entity', 'note:n1')
    expect(root).toHaveAttribute('data-canvas-card-state', 'active')
  })

  it('renders the task editor for a task card', () => {
    render(
      <CanvasCardActive cardRef={cardRef('task', 't1')} state={undefined} onDeactivate={vi.fn()} />
    )
    expect(screen.getByTestId('canvas-task-editor')).toHaveTextContent('t1')
  })

  it('renders the event editor for a calendar_event card, wiring onDone to onDeactivate', () => {
    const onDeactivate = vi.fn()
    render(
      <CanvasCardActive
        cardRef={cardRef('calendar_event', 'ev1')}
        state={undefined}
        onDeactivate={onDeactivate}
      />
    )
    const editor = screen.getByTestId('canvas-event-editor')
    expect(editor).toHaveTextContent('ev1')
    fireEvent.click(editor)
    expect(onDeactivate).toHaveBeenCalledTimes(1)
  })

  it('focuses the container on mount', () => {
    render(
      <CanvasCardActive cardRef={cardRef('note', 'n1')} state={undefined} onDeactivate={vi.fn()} />
    )
    expect(document.querySelector('[data-canvas-active-card="e1"]')).toBe(document.activeElement)
  })

  it('Escape stops propagation and deactivates', () => {
    const onDeactivate = vi.fn()
    render(
      <CanvasCardActive
        cardRef={cardRef('note', 'n1')}
        state={undefined}
        onDeactivate={onDeactivate}
      />
    )
    const root = document.querySelector('[data-canvas-active-card="e1"]') as HTMLElement
    fireEvent.keyDown(root, { key: 'Escape' })
    expect(onDeactivate).toHaveBeenCalledTimes(1)
  })

  it('non-Escape keydown is contained but does not deactivate', () => {
    const onDeactivate = vi.fn()
    render(
      <CanvasCardActive
        cardRef={cardRef('note', 'n1')}
        state={undefined}
        onDeactivate={onDeactivate}
      />
    )
    const root = document.querySelector('[data-canvas-active-card="e1"]') as HTMLElement
    const event = new KeyboardEvent('keydown', { key: 'z', bubbles: true, cancelable: true })
    const stopPropagation = vi.spyOn(event, 'stopPropagation')
    root.dispatchEvent(event)
    expect(stopPropagation).toHaveBeenCalledTimes(1)
    expect(onDeactivate).not.toHaveBeenCalled()
  })

  it('keyup is contained (stopPropagation) so undo/redo never reaches Excalidraw', () => {
    render(
      <CanvasCardActive cardRef={cardRef('note', 'n1')} state={undefined} onDeactivate={vi.fn()} />
    )
    const root = document.querySelector('[data-canvas-active-card="e1"]') as HTMLElement
    const event = new KeyboardEvent('keyup', { key: 'z', bubbles: true, cancelable: true })
    const stopPropagation = vi.spyOn(event, 'stopPropagation')
    root.dispatchEvent(event)
    expect(stopPropagation).toHaveBeenCalledTimes(1)
  })
})
