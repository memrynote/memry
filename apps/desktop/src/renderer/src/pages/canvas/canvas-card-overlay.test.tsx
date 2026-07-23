import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) ?? key })
}))
vi.mock('react-i18next', () => ({ getI18n: () => ({ getFixedT: () => (k: string) => k }) }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const mocks = vi.hoisted(() => {
  const lockCtxCache = new Map<
    string | null,
    { collaborationActive: boolean; visibleNoteTabIds: Set<string> }
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
    getLockCtx(): { collaborationActive: boolean; visibleNoteTabIds: Set<string> } {
      const key = this.lockReason
      if (!lockCtxCache.has(key)) {
        lockCtxCache.set(key, { collaborationActive: key === null, visibleNoteTabIds: new Set() })
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
