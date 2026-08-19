import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CanvasCardLayer } from './canvas-card-overlay'
import { CANVAS_ITEM_DRAG_MIME, noteCardSize, type CardElement } from './canvas-cards'
import { revealScroll } from './canvas-add-card'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'

// Stub the Excalidraw runtime imports so the overlay mounts in jsdom without
// pulling the real (canvas-dependent) library.
vi.mock('@excalidraw/excalidraw', () => ({
  convertToExcalidrawElements: (skeletons: unknown[]) =>
    skeletons.map((s, i) => ({ ...(s as object), id: `new-${i}` })),
  viewportCoordsToSceneCoords: ({ clientX, clientY }: { clientX: number; clientY: number }) => ({
    x: clientX,
    y: clientY
  }),
  CaptureUpdateAction: { IMMEDIATELY: 'immediately' }
}))

// dnd-kit's monitor throws outside a DndContext, and a real DndContext gives
// no way to synthesize a drag in jsdom. Capturing the listeners instead lets
// the suite drive the overlay's own drop handler directly — the mapping it
// feeds on is unit-tested in canvas-drop-entity.test.ts.
const dnd = vi.hoisted(() => ({
  listeners: {} as {
    onDragStart?: (event: unknown) => void
    onDragEnd?: (event: unknown) => void
    onDragCancel?: () => void
  },
  isOver: false,
  droppableId: null as string | null,
  droppableData: null as unknown,
  dragContext: null as { dragState: { draggedTasks: { id: string }[] } } | null
}))

vi.mock('@/contexts/drag-context', () => ({
  useOptionalDragContext: () => dnd.dragContext
}))

vi.mock('@dnd-kit/core', () => ({
  useDndMonitor: (listeners: typeof dnd.listeners) => {
    dnd.listeners = listeners
  },
  useDroppable: ({ id, data }: { id: string; data: unknown }) => {
    dnd.droppableId = id
    dnd.droppableData = data
    return { setNodeRef: () => {}, isOver: dnd.isOver }
  }
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) ?? key })
}))
vi.mock('react-i18next', () => ({ getI18n: () => ({ getFixedT: () => (k: string) => k }) }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const mocks = vi.hoisted(() => {
  const lockCtxCache = new Map<
    string | null,
    { hasLiveFragment: () => boolean; visibleNoteTabIds: Set<string> }
  >()
  return {
    openTab: vi.fn(),
    notesCreate: vi.fn(),
    notesGet: vi.fn(),
    entities: new Map<string, unknown>(),
    lockReason: null as string | null,
    // Cached per lockReason value so the returned reference is stable across
    // re-renders while the reason is unchanged — mirrors the real hook's
    // useMemo. A fresh object on every call would make the overlay's
    // yield-to-tab effect (deps on this reference) re-run on every render
    // regardless of whether the lock actually changed, confounding tests that
    // want to isolate the activation gate from that effect.
    getLockCtx(): { hasLiveFragment: () => boolean; visibleNoteTabIds: Set<string> } {
      const key = this.lockReason
      if (!lockCtxCache.has(key)) {
        lockCtxCache.set(key, { hasLiveFragment: () => key === null, visibleNoteTabIds: new Set() })
      }
      return lockCtxCache.get(key)!
    }
  }
})

vi.mock('@/contexts/tabs', () => ({ useTabActions: () => ({ openTab: mocks.openTab }) }))
// This suite's subject is overlay geometry, not the note-edit lock decision
// itself (covered by use-note-edit-lock.test.tsx against the real providers,
// SyncProvider/TabProvider not needed here). mocks.lockReason drives the
// stub so individual tests can flip it — the enforcement POINT (activation
// gate, claim refusal, yield-to-tab effect, locked prop passthrough) is this
// suite's subject and needs the lock to actually be able to trigger.
vi.mock('./use-note-edit-lock', () => ({
  useNoteEditLock: () => mocks.getLockCtx(),
  lockReasonForCard: () => mocks.lockReason
}))
vi.mock('@/services/notes-service', () => ({
  notesService: {
    create: (input: unknown) => mocks.notesCreate(input),
    // A new card is sized from the note's body, so placement reads it first.
    get: (id: string) => mocks.notesGet(id)
  }
}))
vi.mock('./use-canvas-entities', async () => {
  const actual =
    await vi.importActual<typeof import('./use-canvas-entities')>('./use-canvas-entities')
  return { entityKey: actual.entityKey, useCanvasEntities: () => mocks.entities }
})
// Keep the card lightweight; its own test covers rendering.
vi.mock('./canvas-card', () => ({
  CanvasCard: ({
    cardRef,
    onRedirect,
    locked
  }: {
    cardRef: { elementId: string; entityType: string; entityId: string }
    onRedirect: (c: unknown) => void
    locked?: string | null
  }) => (
    <button
      data-testid={`card-${cardRef.elementId}`}
      data-canvas-card-locked={locked ? 'true' : undefined}
      onClick={() => onRedirect(cardRef)}
    >
      {cardRef.entityId}
    </button>
  )
}))
// Stub the embedded note editor leaf so the real CanvasCardActive (whose
// data-attrs + keyboard containment these tests exercise) renders without
// pulling ContentArea → react-pdf (which needs DOMMatrix, absent in jsdom).
vi.mock('./embedded-note-editor', () => ({
  EmbeddedNoteEditor: ({ noteId }: { noteId: string }) => (
    <div data-testid={`embedded-note-${noteId}`} />
  )
}))
// The read-only twin needs the same treatment: CanvasCardBody imports it
// unconditionally, so it reaches react-pdf through editor-schema even when no
// idle card renders. Without this the whole suite dies at import.
vi.mock('./canvas-note-body', () => ({
  CanvasNoteBody: ({ noteId }: { noteId: string }) => <div data-testid={`note-body-${noteId}`} />
}))
// Stub the picker; its own test covers filtering and selection. Exposes
// onReveal for the overlay's handleReveal wiring (FIX 8): a fixed testid
// button reveals card n2, so the caller doesn't need cmdk's real UI.
vi.mock('./canvas-add-card-dialog', () => ({
  CanvasAddCardDialog: ({
    open,
    onCreateNote,
    onReveal
  }: {
    open: boolean
    onCreateNote: (title: string) => void
    onReveal: (entityType: string, entityId: string) => void
  }) =>
    open ? (
      <>
        <button data-testid="stub-create-note" onClick={() => onCreateNote('')}>
          create
        </button>
        <button data-testid="stub-reveal-n2" onClick={() => onReveal('note', 'n2')}>
          reveal
        </button>
      </>
    ) : null
}))

function cardEl(id: string, entityId: string, x = 0, y = 0): CardElement {
  return {
    id,
    type: 'rectangle',
    x,
    y,
    width: 260,
    height: 168,
    angle: 0,
    customData: { entityType: 'note', entityId }
  }
}

function makeApi(elements: CardElement[]): {
  api: ExcalidrawImperativeAPI
  fire: () => void
  updateScene: ReturnType<typeof vi.fn>
} {
  let onChangeCb: (() => void) | null = null
  const updateScene = vi.fn()
  const api = {
    getSceneElements: () => elements,
    getSceneElementsIncludingDeleted: () => elements,
    getAppState: () => ({
      scrollX: 0,
      scrollY: 0,
      zoom: { value: 1 },
      offsetLeft: 0,
      offsetTop: 0
    }),
    getFiles: () => ({}),
    updateScene,
    refresh: vi.fn(),
    onChange: (cb: () => void) => {
      onChangeCb = cb
      return () => {}
    }
  } as unknown as ExcalidrawImperativeAPI
  return { api, fire: () => onChangeCb?.(), updateScene }
}

function Harness({
  api,
  onSceneMutated = vi.fn()
}: {
  api: ExcalidrawImperativeAPI
  onSceneMutated?: () => void
}) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  return (
    <div ref={wrapperRef} data-testid="wrapper">
      <CanvasCardLayer
        excalidrawAPI={api}
        wrapperRef={wrapperRef}
        onSceneMutated={onSceneMutated}
      />
    </div>
  )
}

describe('CanvasCardLayer', () => {
  beforeEach(() => {
    mocks.openTab.mockReset()
    mocks.notesCreate.mockReset()
    mocks.notesGet.mockReset()
    mocks.notesGet.mockResolvedValue({ id: 'n', content: '' })
    mocks.entities = new Map()
    mocks.lockReason = null
  })

  it('renders a card for each visible card element', async () => {
    const { api } = makeApi([cardEl('e1', 'n1'), cardEl('e2', 'n2')])
    render(<Harness api={api} />)
    await waitFor(() => {
      expect(screen.getByTestId('card-e1')).toBeInTheDocument()
      expect(screen.getByTestId('card-e2')).toBeInTheDocument()
    })
  })

  it('creates a referencing card element on a canvas-item drop', async () => {
    const { api, updateScene } = makeApi([])
    const onSceneMutated = vi.fn()
    render(<Harness api={api} onSceneMutated={onSceneMutated} />)

    const wrapper = screen.getByTestId('wrapper')
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', {
      value: {
        types: [CANVAS_ITEM_DRAG_MIME],
        getData: (t: string) =>
          t === CANVAS_ITEM_DRAG_MIME
            ? JSON.stringify({ entityType: 'note', entityId: 'dropped' })
            : ''
      }
    })
    Object.defineProperty(drop, 'clientX', { value: 120 })
    Object.defineProperty(drop, 'clientY', { value: 80 })
    wrapper.dispatchEvent(drop)

    await waitFor(() => expect(updateScene).toHaveBeenCalled())
    const passed = updateScene.mock.calls[0][0]
    expect(passed.captureUpdate).toBe('immediately')
    expect(
      passed.elements.some(
        (e: { customData?: { entityId?: string } }) => e.customData?.entityId === 'dropped'
      )
    ).toBe(true)
    expect(onSceneMutated).toHaveBeenCalled()
  })

  it('sizes a dropped note card from its body, not a fixed frame', async () => {
    // The "hey" regression: every note card opened at the maximum frame. The
    // drop path must read the body and hand makeCardSkeleton a measured size.
    async function dropNoteWithBody(content: string): Promise<{ width: number; height: number }> {
      mocks.notesGet.mockResolvedValue({ id: 'dropped', content })
      const { api, updateScene } = makeApi([])
      const { unmount } = render(<Harness api={api} />)
      const wrapper = screen.getByTestId('wrapper')
      const drop = new Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperty(drop, 'dataTransfer', {
        value: {
          types: [CANVAS_ITEM_DRAG_MIME],
          getData: (t: string) =>
            t === CANVAS_ITEM_DRAG_MIME
              ? JSON.stringify({ entityType: 'note', entityId: 'dropped' })
              : ''
        }
      })
      Object.defineProperty(drop, 'clientX', { value: 120 })
      Object.defineProperty(drop, 'clientY', { value: 80 })
      wrapper.dispatchEvent(drop)
      await waitFor(() => expect(updateScene).toHaveBeenCalled())
      const element = updateScene.mock.calls[0][0].elements.find(
        (e: { customData?: { entityId?: string } }) => e.customData?.entityId === 'dropped'
      ) as { width: number; height: number }
      unmount()
      return { width: element.width, height: element.height }
    }

    const tiny = await dropNoteWithBody('hey')
    const big = await dropNoteWithBody(
      Array.from(
        { length: 200 },
        (_, i) => `Paragraph ${i}. ${'A real sentence here. '.repeat(6)}`
      ).join('\n')
    )

    expect(tiny).toEqual(noteCardSize('hey'))
    expect(big.width).toBeGreaterThan(tiny.width)
    expect(big.height).toBeGreaterThan(tiny.height)
  })

  it('ignores drops without the canvas MIME', async () => {
    const { api, updateScene } = makeApi([])
    render(<Harness api={api} />)
    const wrapper = screen.getByTestId('wrapper')
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', {
      value: { types: ['text/plain'], getData: () => '' }
    })
    wrapper.dispatchEvent(drop)
    // No card created.
    expect(updateScene).not.toHaveBeenCalled()
  })

  it('opens a tab when a card requests redirect', async () => {
    mocks.entities = new Map([['note:n1', { status: 'ready', kind: 'note', title: 'Note One' }]])
    const { api } = makeApi([cardEl('e1', 'n1')])
    render(<Harness api={api} />)
    fireEvent.click(await screen.findByTestId('card-e1'))
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'note', entityId: 'n1', title: 'Note One' })
    )
  })

  it('capture-first: creates a note then a card element', async () => {
    mocks.notesCreate.mockResolvedValue({ success: true, note: { id: 'captured' } })
    const { api, updateScene } = makeApi([])
    render(<Harness api={api} />)

    fireEvent.click(screen.getByTestId('canvas-add-card'))
    fireEvent.click(screen.getByTestId('stub-create-note'))
    await waitFor(() => expect(mocks.notesCreate).toHaveBeenCalled())
    await waitFor(() => expect(updateScene).toHaveBeenCalled())
    const passed = updateScene.mock.calls[0][0]
    expect(
      passed.elements.some(
        (e: { customData?: { entityId?: string } }) => e.customData?.entityId === 'captured'
      )
    ).toBe(true)
  })

  it('offsets a placed card off one already sitting at the viewport centre (#871)', async () => {
    mocks.notesCreate.mockResolvedValue({ success: true, note: { id: 'captured' } })
    // jsdom reports a 0-size clip, so the viewport centre is (0, 0) — this card
    // covers it, and the new card must not be dropped on top of it.
    const occupied = cardEl('e1', 'n1', -130, -84)
    const { api, updateScene } = makeApi([occupied])
    render(<Harness api={api} />)

    fireEvent.click(screen.getByTestId('canvas-add-card'))
    fireEvent.click(screen.getByTestId('stub-create-note'))
    await waitFor(() => expect(updateScene).toHaveBeenCalled())

    const created = updateScene.mock.calls[0][0].elements.find(
      (e: { customData?: { entityId?: string } }) => e.customData?.entityId === 'captured'
    )
    expect(created).toBeDefined()
    expect(
      created.x >= occupied.x + occupied.width ||
        created.x + created.width <= occupied.x ||
        created.y >= occupied.y + occupied.height ||
        created.y + created.height <= occupied.y
    ).toBe(true)
  })

  it('reveals an existing card (searching the whole scene, not just visible cards) without adding a new element', async () => {
    mocks.entities = new Map([
      ['note:n1', { status: 'ready', kind: 'note', title: 'One' }],
      ['note:n2', { status: 'ready', kind: 'note', title: 'Two' }]
    ])
    // e2 sits far outside the (0-size, in jsdom) viewport so it is NOT among
    // the mounted/visible cards — proving handleReveal searches every scene
    // element via readScene(), not just the rendered subset.
    const { api, updateScene } = makeApi([cardEl('e1', 'n1', 0, 0), cardEl('e2', 'n2', 1000, 1000)])
    render(<Harness api={api} />)

    fireEvent.click(screen.getByTestId('canvas-add-card'))
    fireEvent.click(screen.getByTestId('stub-reveal-n2'))

    await waitFor(() => expect(updateScene).toHaveBeenCalled())
    const passed = updateScene.mock.calls[0][0]
    const expected = revealScroll(
      { x: 1000, y: 1000, width: 260, height: 168 },
      { width: 0, height: 0 },
      1
    )
    expect(passed.captureUpdate).toBe('immediately')
    expect(passed.appState.scrollX).toBe(expected.scrollX)
    expect(passed.appState.scrollY).toBe(expected.scrollY)
    expect(passed.appState.selectedElementIds).toEqual({ e2: true })
    // Revealing centers the existing card — it must not create a new element.
    expect(passed.elements).toBeUndefined()
  })

  it('activates (not redirects) on a dblclick that hits a card', async () => {
    mocks.entities = new Map([['note:n1', { status: 'ready', kind: 'note', title: 'Hit' }]])
    const { api, fire } = makeApi([cardEl('e1', 'n1', 100, 100)])
    render(<Harness api={api} />)
    fire()
    const wrapper = screen.getByTestId('wrapper')
    const dbl = new MouseEvent('dblclick', {
      bubbles: true,
      cancelable: true,
      clientX: 150,
      clientY: 150
    })
    wrapper.dispatchEvent(dbl)
    await waitFor(() =>
      expect(document.querySelector('[data-canvas-active-card="e1"]')).toBeInTheDocument()
    )
    expect(document.querySelector('[data-canvas-card-entity="note:n1"]')).toHaveAttribute(
      'data-canvas-card-state',
      'active'
    )
    expect(mocks.openTab).not.toHaveBeenCalled()
  })

  it('Escape deactivates the active card', async () => {
    mocks.entities = new Map([['note:n1', { status: 'ready', kind: 'note', title: 'Hit' }]])
    const { api, fire } = makeApi([cardEl('e1', 'n1', 100, 100)])
    render(<Harness api={api} />)
    fire()
    const wrapper = screen.getByTestId('wrapper')
    wrapper.dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 150, clientY: 150 })
    )
    const active = await waitFor(() => {
      const el = document.querySelector('[data-canvas-active-card="e1"]')
      expect(el).toBeInTheDocument()
      return el as HTMLElement
    })
    fireEvent.keyDown(active, { key: 'Escape' })
    await waitFor(() =>
      expect(document.querySelector('[data-canvas-active-card]')).not.toBeInTheDocument()
    )
  })

  it('click-away pointerdown deactivates the active card without swallowing it', async () => {
    mocks.entities = new Map([['note:n1', { status: 'ready', kind: 'note', title: 'Hit' }]])
    const { api, fire } = makeApi([cardEl('e1', 'n1', 100, 100)])
    render(<Harness api={api} />)
    fire()
    const wrapper = screen.getByTestId('wrapper')
    wrapper.dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 150, clientY: 150 })
    )
    await waitFor(() =>
      expect(document.querySelector('[data-canvas-active-card="e1"]')).toBeInTheDocument()
    )
    const pointerdown = new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 10
    })
    const stopPropagation = vi.spyOn(pointerdown, 'stopPropagation')
    wrapper.dispatchEvent(pointerdown)
    await waitFor(() =>
      expect(document.querySelector('[data-canvas-active-card]')).not.toBeInTheDocument()
    )
    // C4: the deactivating pointerdown must still be free to pan/select.
    expect(stopPropagation).not.toHaveBeenCalled()
  })

  describe('M7 note-edit lock enforcement', () => {
    it('refuses to activate a locked card on dblclick', async () => {
      mocks.lockReason = 'note-open-in-tab'
      mocks.entities = new Map([['note:n1', { status: 'ready', kind: 'note', title: 'Hit' }]])
      const { api, fire } = makeApi([cardEl('e1', 'n1', 100, 100)])
      render(<Harness api={api} />)
      fire()
      const wrapper = screen.getByTestId('wrapper')
      wrapper.dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 150, clientY: 150 })
      )
      // The raw dispatchEvent above isn't wrapped in act(), so a synchronous
      // check right after it could pass even with the gate removed (the state
      // update just hasn't landed on the DOM yet) — give it a tick first so
      // this assertion can genuinely fail.
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(document.querySelector('[data-canvas-active-card]')).not.toBeInTheDocument()
    })

    it('deactivates an already-active card once it becomes locked (yield-to-tab effect)', async () => {
      mocks.entities = new Map([['note:n1', { status: 'ready', kind: 'note', title: 'Hit' }]])
      const { api, fire } = makeApi([cardEl('e1', 'n1', 100, 100)])
      const { rerender } = render(<Harness api={api} />)
      fire()
      const wrapper = screen.getByTestId('wrapper')
      wrapper.dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 150, clientY: 150 })
      )
      await waitFor(() =>
        expect(document.querySelector('[data-canvas-active-card="e1"]')).toBeInTheDocument()
      )

      // The note becomes live in another visible pane — the lock context
      // changes and the yield-to-tab effect must deactivate the card.
      mocks.lockReason = 'note-open-in-tab'
      rerender(<Harness api={api} />)

      expect(document.querySelector('[data-canvas-active-card]')).not.toBeInTheDocument()
    })

    it('passes the locked prop down to an idle card', async () => {
      mocks.lockReason = 'note-open-in-tab'
      mocks.entities = new Map([['note:n1', { status: 'ready', kind: 'note', title: 'Hit' }]])
      const { api } = makeApi([cardEl('e1', 'n1')])
      render(<Harness api={api} />)
      await waitFor(() =>
        expect(screen.getByTestId('card-e1')).toHaveAttribute('data-canvas-card-locked', 'true')
      )
    })
  })
})

describe('CanvasCardLayer — dnd-kit drops', () => {
  beforeEach(() => {
    mocks.entities = new Map()
    mocks.lockReason = null
    dnd.listeners = {}
    dnd.isOver = false
    dnd.droppableId = null
    dnd.droppableData = null
    dnd.dragContext = null
  })

  /** A dnd-kit drag-end landing on the canvas droppable at (clientX, clientY). */
  function dropEvent(
    data: Record<string, unknown>,
    activeId: string,
    at: { clientX: number; clientY: number } | null = { clientX: 120, clientY: 80 },
    overId: string | null = dnd.droppableId
  ): unknown {
    return {
      active: { id: activeId, data: { current: data } },
      over: overId === null ? null : { id: overId },
      activatorEvent: at ?? {},
      delta: { x: 0, y: 0 }
    }
  }

  function entityIds(passed: { elements: { customData?: { entityId?: string } }[] }): string[] {
    return passed.elements.map((e) => e.customData?.entityId).filter(Boolean) as string[]
  }

  it('registers a droppable that task drop handlers can tell apart', () => {
    const { api } = makeApi([])
    render(<Harness api={api} />)
    expect(dnd.droppableId).toBeTruthy()
    // use-drag-handlers switches on over.data.current.type; 'canvas' must not
    // collide with a task drop target or the task would also be rescheduled.
    expect(dnd.droppableData).toEqual({ type: 'canvas' })
  })

  it('cards a task dropped from a task list at the drop point', async () => {
    const { api, updateScene } = makeApi([])
    const onSceneMutated = vi.fn()
    render(<Harness api={api} onSceneMutated={onSceneMutated} />)

    act(() => {
      dnd.listeners.onDragEnd?.(dropEvent({ type: 'task', task: { id: 't1' } }, 't1'))
    })

    await waitFor(() => expect(updateScene).toHaveBeenCalled())
    const passed = updateScene.mock.calls[0][0]
    expect(entityIds(passed)).toEqual(['t1'])
    const card = passed.elements[0]
    expect(card.customData).toEqual({ entityType: 'task', entityId: 't1' })
    // makeApi's viewport is 1:1 at the origin, so scene == client coords, and
    // the skeleton is centred on the drop point.
    expect(card.x + card.width / 2).toBe(120)
    expect(card.y + card.height / 2).toBe(80)
    expect(onSceneMutated).toHaveBeenCalled()
  })

  it('cards a calendar event dragged from a calendar view', async () => {
    const { api, updateScene } = makeApi([])
    render(<Harness api={api} />)

    act(() => {
      dnd.listeners.onDragEnd?.(
        dropEvent(
          { type: 'canvas-entity', entityType: 'calendar_event', entityId: 'ev1' },
          'canvas-event:ev1'
        )
      )
    })

    await waitFor(() => expect(updateScene).toHaveBeenCalled())
    expect(updateScene.mock.calls[0][0].elements[0].customData).toEqual({
      entityType: 'calendar_event',
      entityId: 'ev1'
    })
  })

  it('ignores a drop that landed on another droppable', () => {
    const { api, updateScene } = makeApi([])
    render(<Harness api={api} />)

    act(() => {
      dnd.listeners.onDragEnd?.(
        dropEvent(
          { type: 'task', task: { id: 't1' } },
          't1',
          { clientX: 1, clientY: 1 },
          'some-list'
        )
      )
      dnd.listeners.onDragEnd?.(
        dropEvent({ type: 'task', task: { id: 't1' } }, 't1', { clientX: 1, clientY: 1 }, null)
      )
    })

    expect(updateScene).not.toHaveBeenCalled()
  })

  it('ignores a drag the canvas cannot place', () => {
    const { api, updateScene } = makeApi([])
    render(<Harness api={api} />)

    act(() => {
      dnd.listeners.onDragEnd?.(dropEvent({ type: 'column', columnId: 'c1' }, 'c1'))
    })

    expect(updateScene).not.toHaveBeenCalled()
  })

  it('places one card per task of a multi-select drop, without stacking them', async () => {
    dnd.dragContext = {
      dragState: { draggedTasks: [{ id: 't1' }, { id: 't2' }, { id: 't3' }] }
    }
    const { api, updateScene } = makeApi([])
    render(<Harness api={api} />)

    act(() => {
      dnd.listeners.onDragEnd?.(dropEvent({ type: 'task', task: { id: 't1' } }, 't1'))
    })

    await waitFor(() => expect(updateScene).toHaveBeenCalled())
    const passed = updateScene.mock.calls[0][0]
    expect(entityIds(passed)).toEqual(['t1', 't2', 't3'])
    const centers = passed.elements.map(
      (e: { x: number; y: number; width: number; height: number }) =>
        `${e.x + e.width / 2},${e.y + e.height / 2}`
    )
    expect(new Set(centers).size).toBe(3)
  })

  it('still places a card when the drag carries no pointer (keyboard sensor)', async () => {
    const { api, updateScene } = makeApi([])
    render(<Harness api={api} />)

    act(() => {
      dnd.listeners.onDragEnd?.(dropEvent({ type: 'task', task: { id: 't1' } }, 't1', null))
    })

    await waitFor(() => expect(updateScene).toHaveBeenCalled())
    expect(entityIds(updateScene.mock.calls[0][0])).toEqual(['t1'])
  })

  it('shows the drop ring only while a placeable drag is over the canvas', async () => {
    dnd.isOver = true
    const { api } = makeApi([])
    const { rerender } = render(<Harness api={api} />)
    expect(screen.queryByTestId('canvas-drop-ring')).toBeNull()

    act(() => {
      dnd.listeners.onDragStart?.({ active: { id: 't1', data: { current: { type: 'task' } } } })
    })
    await waitFor(() => expect(screen.getByTestId('canvas-drop-ring')).toBeInTheDocument())

    act(() => {
      dnd.listeners.onDragCancel?.()
    })
    rerender(<Harness api={api} />)
    await waitFor(() => expect(screen.queryByTestId('canvas-drop-ring')).toBeNull())
  })

  it('does not show the drop ring for a drag the canvas cannot place', async () => {
    dnd.isOver = true
    const { api } = makeApi([])
    render(<Harness api={api} />)

    act(() => {
      dnd.listeners.onDragStart?.({ active: { id: 'c1', data: { current: { type: 'column' } } } })
    })

    await waitFor(() => expect(screen.queryByTestId('canvas-drop-ring')).toBeNull())
  })
})

// --- Recompute scoping (#1052) ----------------------------------------------
//
// Excalidraw triggers its onChange emitter from componentDidUpdate for EVERY
// committed state change, not just scene edits: a pan tick, a zoom tick, a
// pointer-move that only changed which element is hovered. So the work the
// overlay does per onChange is work it does per frame — several times per frame
// while the wheel outruns the display — and `clientWidth`/`clientHeight` in
// that path is a forced synchronous layout in the critical path of every frame.
//
// These tests pin counts (scene reads = full passes, clip measurements = forced
// layouts) and the exact overlay geometry, so an implementation that gets cheap
// by drifting off its cards cannot pass.

/** Clip viewport the counting getters below report, in CSS px. */
const CLIP_WIDTH = 800
const CLIP_HEIGHT = 600

describe('CanvasCardLayer — recompute scoping', () => {
  let clipWidth = CLIP_WIDTH
  let clipHeight = CLIP_HEIGHT
  /** Every clientWidth/clientHeight read anywhere in the tree — one forced layout each. */
  let clipMeasures = 0
  let frames = new Map<number, FrameRequestCallback>()
  let nextFrameId = 1
  let resizeCallbacks: ResizeObserverCallback[] = []
  let widthDescriptor: PropertyDescriptor | undefined
  let heightDescriptor: PropertyDescriptor | undefined

  function flushFrames(): void {
    const pending = [...frames.values()]
    frames = new Map()
    pending.forEach((callback) => callback(0))
  }

  /** The transformed overlay layer — where the whole card plane sits. */
  function layer(): HTMLElement {
    return document.querySelector('[data-canvas-overlay]') as HTMLElement
  }

  /** The absolutely positioned box wrapping one card. */
  function cardBox(elementId: string): Record<string, string> {
    const style = (screen.getByTestId(`card-${elementId}`).parentElement as HTMLElement).style
    return {
      left: style.left,
      top: style.top,
      width: style.width,
      height: style.height
    }
  }

  /** A scene whose appState and elements the test mutates between onChange fires. */
  function makeLiveApi(elements: CardElement[]): {
    api: ExcalidrawImperativeAPI
    fire: () => void
    appState: { scrollX: number; scrollY: number; zoom: { value: number } }
    /** Full recompute passes so far — readScene() reads the elements exactly once. */
    passes: () => number
  } {
    let onChangeCb: (() => void) | null = null
    let passes = 0
    const appState = { scrollX: 0, scrollY: 0, zoom: { value: 1 }, offsetLeft: 0, offsetTop: 0 }
    const api = {
      getSceneElements: () => {
        passes += 1
        return elements
      },
      getSceneElementsIncludingDeleted: () => elements,
      getAppState: () => appState,
      getFiles: () => ({}),
      updateScene: vi.fn(),
      refresh: vi.fn(),
      onChange: (cb: () => void) => {
        onChangeCb = cb
        return () => {
          onChangeCb = null
        }
      }
    } as unknown as ExcalidrawImperativeAPI
    return { api, fire: () => onChangeCb?.(), appState, passes: () => passes }
  }

  beforeEach(() => {
    mocks.openTab.mockReset()
    mocks.notesGet.mockReset()
    mocks.notesGet.mockResolvedValue({ id: 'n', content: '' })
    mocks.entities = new Map()
    mocks.lockReason = null
    dnd.listeners = {}
    dnd.isOver = false
    dnd.dragContext = null

    clipWidth = CLIP_WIDTH
    clipHeight = CLIP_HEIGHT
    clipMeasures = 0
    frames = new Map()
    nextFrameId = 1
    resizeCallbacks = []

    // jsdom reports 0 for every layout box, so the viewport would be empty and
    // virtualization untestable. These getters give the clip a real size AND
    // count the reads, which is the forced layout this issue is about.
    widthDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')
    heightDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')
    Object.defineProperty(Element.prototype, 'clientWidth', {
      configurable: true,
      get: () => {
        clipMeasures += 1
        return clipWidth
      }
    })
    Object.defineProperty(Element.prototype, 'clientHeight', {
      configurable: true,
      get: () => {
        clipMeasures += 1
        return clipHeight
      }
    })

    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextFrameId
      nextFrameId += 1
      frames.set(id, callback)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames.delete(id)
    })
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallbacks.push(callback)
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (widthDescriptor) {
      Object.defineProperty(Element.prototype, 'clientWidth', widthDescriptor)
    }
    if (heightDescriptor) {
      Object.defineProperty(Element.prototype, 'clientHeight', heightDescriptor)
    }
  })

  it('coalesces a burst of pan commits into one pass, with the overlay glued meanwhile', () => {
    const { api, fire, appState, passes } = makeLiveApi([
      cardEl('e1', 'n1', 0, 0),
      cardEl('e2', 'n2', 400, 0)
    ])
    render(<Harness api={api} />)

    // Mount: one pass, one clip measurement (width + height).
    expect(passes()).toBe(1)
    expect(clipMeasures).toBe(2)
    expect(layer().style.transform).toBe('translate(0px, 0px) scale(1)')

    const passesBefore = passes()
    const measuresBefore = clipMeasures
    // Five pan commits landing before the browser gets a frame.
    for (let step = 1; step <= 5; step += 1) {
      appState.scrollX = -step * 10
      fire()
    }

    // The layer must already be over the panned scene — waiting for the frame
    // would leave every card lagging the rectangle it covers.
    expect(layer().style.transform).toBe('translate(-50px, 0px) scale(1)')
    expect(passes()).toBe(passesBefore)

    act(flushFrames)

    expect(passes() - passesBefore).toBe(1)
    expect(clipMeasures - measuresBefore).toBe(0)
    expect(layer().style.transform).toBe('translate(-50px, 0px) scale(1)')
    expect(cardBox('e1')).toEqual({ left: '0px', top: '0px', width: '260px', height: '168px' })
    expect(cardBox('e2')).toEqual({ left: '400px', top: '0px', width: '260px', height: '168px' })
  })

  it('applies zoom to the layer immediately and leaves card boxes in scene units', () => {
    const { api, fire, appState, passes } = makeLiveApi([cardEl('e1', 'n1', 0, 0)])
    render(<Harness api={api} />)
    const passesBefore = passes()
    const measuresBefore = clipMeasures

    appState.zoom = { value: 2 }
    appState.scrollX = 20
    appState.scrollY = -30
    fire()
    fire()
    fire()

    expect(layer().style.transform).toBe('translate(40px, -60px) scale(2)')

    act(flushFrames)

    expect(passes() - passesBefore).toBe(1)
    expect(clipMeasures - measuresBefore).toBe(0)
    expect(layer().style.transform).toBe('translate(40px, -60px) scale(2)')
    // Cards are positioned in scene coordinates; the layer's scale does the zoom.
    expect(cardBox('e1')).toEqual({ left: '0px', top: '0px', width: '260px', height: '168px' })
  })

  it('follows a dragged element to its exact new geometry', () => {
    const moved = cardEl('e1', 'n1', 0, 0)
    const { api, fire, passes } = makeLiveApi([moved])
    render(<Harness api={api} />)
    const passesBefore = passes()
    const measuresBefore = clipMeasures

    // Excalidraw mutates elements in place during a drag and commits per tick.
    moved.x = 120
    moved.y = 45
    fire()
    moved.x = 137
    moved.y = 52
    fire()

    act(flushFrames)

    expect(passes() - passesBefore).toBe(1)
    expect(clipMeasures - measuresBefore).toBe(0)
    expect(cardBox('e1')).toEqual({ left: '137px', top: '52px', width: '260px', height: '168px' })
  })

  it('unmounts a card deleted from the scene', () => {
    const elements = [cardEl('e1', 'n1', 0, 0), cardEl('e2', 'n2', 400, 0)]
    const { api, fire } = makeLiveApi(elements)
    render(<Harness api={api} />)
    expect(screen.getByTestId('card-e2')).toBeInTheDocument()

    elements[1].isDeleted = true
    fire()
    act(flushFrames)

    expect(screen.queryByTestId('card-e2')).toBeNull()
    expect(cardBox('e1')).toEqual({ left: '0px', top: '0px', width: '260px', height: '168px' })
  })

  it('re-measures the clip after a resize, so a card entering the wider viewport mounts', () => {
    // e2 sits past 800px viewport + 200px enter padding, so it starts unmounted.
    const { api } = makeLiveApi([cardEl('e1', 'n1', 0, 0), cardEl('e2', 'n2', 1500, 0)])
    render(<Harness api={api} />)
    expect(screen.queryByTestId('card-e2')).toBeNull()

    // A window resize / sidebar toggle widens the clip. Nothing about the scene
    // or the viewport transform changed, so only a fresh clip measurement can
    // bring e2 in — a held size would leave a blank hole where the card is.
    clipWidth = 2000
    act(() => {
      resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver))
    })

    expect(screen.getByTestId('card-e2')).toBeInTheDocument()
    expect(cardBox('e2')).toEqual({ left: '1500px', top: '0px', width: '260px', height: '168px' })
  })

  it('drops a scheduled pass when the layer unmounts before the frame runs', () => {
    const { api, fire, passes } = makeLiveApi([cardEl('e1', 'n1', 0, 0)])
    const { unmount } = render(<Harness api={api} />)
    const passesBefore = passes()

    fire()
    unmount()
    act(flushFrames)

    expect(passes()).toBe(passesBefore)
  })
})
