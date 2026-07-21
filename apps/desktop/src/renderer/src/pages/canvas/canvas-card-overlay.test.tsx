import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CanvasCardLayer } from './canvas-card-overlay'
import { CANVAS_ITEM_DRAG_MIME, type CardElement } from './canvas-cards'
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

const mocks = vi.hoisted(() => ({
  openTab: vi.fn(),
  notesCreate: vi.fn(),
  entities: new Map<string, unknown>()
}))

vi.mock('@/contexts/tabs', () => ({ useTabActions: () => ({ openTab: mocks.openTab }) }))
vi.mock('@/services/notes-service', () => ({
  notesService: { create: (input: unknown) => mocks.notesCreate(input) }
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
    onRedirect
  }: {
    cardRef: { elementId: string; entityType: string; entityId: string }
    onRedirect: (c: unknown) => void
  }) => (
    <button data-testid={`card-${cardRef.elementId}`} onClick={() => onRedirect(cardRef)}>
      {cardRef.entityId}
    </button>
  )
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
    mocks.entities = new Map()
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

    fireEvent.click(screen.getByTestId('canvas-new-note'))
    await waitFor(() => expect(mocks.notesCreate).toHaveBeenCalled())
    await waitFor(() => expect(updateScene).toHaveBeenCalled())
    const passed = updateScene.mock.calls[0][0]
    expect(
      passed.elements.some(
        (e: { customData?: { entityId?: string } }) => e.customData?.entityId === 'captured'
      )
    ).toBe(true)
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
})
