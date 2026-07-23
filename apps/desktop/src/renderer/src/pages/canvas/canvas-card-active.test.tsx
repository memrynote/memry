import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CanvasCardActive } from './canvas-card-active'
import type { CanvasCardRef } from './canvas-cards'

// Stub the shared body so this test exercises only the container's own
// concerns: data attributes, focus-on-mount, and keyboard containment. Which
// editor each entity type gets is canvas-card-body.test.tsx's job, and the stub
// keeps BlockNote/react-pdf and the task/calendar query stacks out of this
// module graph.
vi.mock('./canvas-card-body', () => ({
  CanvasCardBody: ({
    cardRef,
    interactive,
    onDone
  }: {
    cardRef: CanvasCardRef
    interactive: boolean
    onDone?: () => void
  }) => (
    <button data-testid="canvas-card-body" data-interactive={String(interactive)} onClick={onDone}>
      {`${cardRef.entityType}:${cardRef.entityId}`}
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
  it('renders the shared body as interactive and sets its data attributes', () => {
    render(
      <CanvasCardActive cardRef={cardRef('note', 'n1')} state={undefined} onDeactivate={vi.fn()} />
    )
    const body = screen.getByTestId('canvas-card-body')
    expect(body).toHaveTextContent('note:n1')
    expect(body).toHaveAttribute('data-interactive', 'true')
    const root = document.querySelector('[data-canvas-active-card="e1"]')
    expect(root).toHaveAttribute('data-canvas-card-id', 'e1')
    expect(root).toHaveAttribute('data-canvas-card-entity', 'note:n1')
    expect(root).toHaveAttribute('data-canvas-card-state', 'active')
  })

  it('passes the card through to the body for every entity type', () => {
    const { rerender } = render(
      <CanvasCardActive cardRef={cardRef('task', 't1')} state={undefined} onDeactivate={vi.fn()} />
    )
    expect(screen.getByTestId('canvas-card-body')).toHaveTextContent('task:t1')

    rerender(
      <CanvasCardActive
        cardRef={cardRef('calendar_event', 'ev1')}
        state={undefined}
        onDeactivate={vi.fn()}
      />
    )
    expect(screen.getByTestId('canvas-card-body')).toHaveTextContent('calendar_event:ev1')
  })

  it('wires the body onDone to onDeactivate (event cards close after save)', () => {
    const onDeactivate = vi.fn()
    render(
      <CanvasCardActive
        cardRef={cardRef('calendar_event', 'ev1')}
        state={undefined}
        onDeactivate={onDeactivate}
      />
    )
    fireEvent.click(screen.getByTestId('canvas-card-body'))
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
