import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'

import { CanvasFrameLayer } from './canvas-frame-layer'
import { FRAME_BINDING_KEY, type FrameSceneElement } from './canvas-frame-binding'

vi.mock('@excalidraw/excalidraw', () => ({
  convertToExcalidrawElements: (skeletons: Record<string, unknown>[]) =>
    skeletons.map((s, i) => ({ ...s, id: `frame-new-${i}`, x: 0, y: 0, width: 1, height: 1 })),
  CaptureUpdateAction: { IMMEDIATELY: 'immediately' }
}))
vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key
  })
}))

const mocks = vi.hoisted(() => ({
  apply: vi.fn(),
  remove: vi.fn(),
  revert: vi.fn(),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  propsGet: vi.fn(),
  bindingDialog: null as null | {
    open: boolean
    onPick: (binding: unknown) => void
    onUnbind: () => void
  },
  layoutDialog: null as null | { onPick: (property: unknown) => void }
}))

vi.mock('sonner', () => ({ toast: mocks.toast }))
vi.mock('./canvas-frame-categorize', () => ({
  applyFrameBinding: mocks.apply,
  removeFrameBinding: mocks.remove
}))
// The dialogs have their own suite; here they only hand their callbacks out.
vi.mock('./canvas-frame-binding-dialog', () => ({
  CanvasFrameBindingDialog: (props: {
    open: boolean
    onPick: (binding: unknown) => void
    onUnbind: () => void
  }) => {
    mocks.bindingDialog = props
    return null
  }
}))
vi.mock('./canvas-frame-layout-dialog', () => ({
  CanvasFrameLayoutDialog: (props: { onPick: (property: unknown) => void }) => {
    mocks.layoutDialog = props
    return null
  }
}))
vi.mock('@/services/properties-service', () => ({
  propertiesService: { get: (id: string) => mocks.propsGet(id) }
}))

const tag = { kind: 'tag', tag: 'health/sleep' }

const card = (id: string, frameId: string | null, x = 0): FrameSceneElement => ({
  id,
  type: 'rectangle',
  x,
  y: 0,
  width: 100,
  height: 50,
  angle: 0,
  frameId,
  customData: { entityType: 'note', entityId: `n-${id}` }
})

const boundFrame: FrameSceneElement = {
  id: 'f1',
  type: 'frame',
  x: 500,
  y: 0,
  width: 400,
  height: 300,
  angle: 0,
  name: '#health/sleep',
  customData: { [FRAME_BINDING_KEY]: tag }
}

function fakeApi(initial: FrameSceneElement[], selectedElementIds: Record<string, boolean> = {}) {
  const listeners = new Set<() => void>()
  const scene = { elements: initial as readonly FrameSceneElement[] }
  const api = {
    getSceneElementsIncludingDeleted: () => scene.elements,
    getAppState: () => ({
      isLoading: false,
      scrollX: 0,
      scrollY: 0,
      zoom: { value: 1 },
      selectedElementIds
    }),
    onChange: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    // Like the real editor, a scene update is followed by onChange.
    updateScene: vi.fn(({ elements }: { elements: FrameSceneElement[] }) => {
      scene.elements = elements
      for (const listener of listeners) listener()
    }),
    scrollToContent: vi.fn()
  }
  const commit = (elements: FrameSceneElement[]): void => {
    scene.elements = elements
    act(() => {
      for (const listener of listeners) listener()
    })
  }
  return { api, scene, commit }
}

function mount(
  elements: FrameSceneElement[],
  editable = true,
  selectedElementIds: Record<string, boolean> = {}
) {
  const fake = fakeApi(elements, selectedElementIds)
  const onSceneMutated = vi.fn()
  render(
    <CanvasFrameLayer
      excalidrawAPI={fake.api as unknown as ExcalidrawImperativeAPI}
      editable={editable}
      onSceneMutated={onSceneMutated}
      layoutOpen={false}
      onLayoutOpenChange={() => {}}
    />
  )
  return { ...fake, onSceneMutated }
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  // Deferred like the real thing: the layer stores the handle it returns and
  // only schedules again once the callback has cleared it.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    queueMicrotask(() => cb(0))
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  mocks.apply.mockResolvedValue({ status: 'applied', revert: mocks.revert })
  mocks.revert.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('CanvasFrameLayer', () => {
  it('shows a chip with the binding and card count', () => {
    mount([card('c1', 'f1'), boundFrame])
    const chip = screen.getByTestId('canvas-frame-chip-f1')
    expect(chip.textContent).toContain('health/sleep')
    expect(chip.textContent).toContain('canvas.frame.cardCount {"count":1}')
  })

  it('does not categorize cards already inside when the board opens', () => {
    mount([card('c1', 'f1'), boundFrame])
    expect(mocks.apply).not.toHaveBeenCalled()
  })

  it('categorizes a card dropped into a bound frame and undoes both halves', async () => {
    const { commit, scene, api } = mount([card('c1', null, 10), boundFrame])
    commit([card('c1', 'f1', 600), boundFrame])
    await flush()

    expect(mocks.apply).toHaveBeenCalledWith({ entityType: 'note', entityId: 'n-c1' }, tag)
    expect(mocks.toast.success).toHaveBeenCalledTimes(1)
    const [, options] = mocks.toast.success.mock.calls[0] as [
      string,
      { action: { onClick: () => void } }
    ]

    act(() => options.action.onClick())
    await flush()

    expect(api.updateScene).toHaveBeenCalledTimes(1)
    const moved = scene.elements.find((el) => el.id === 'c1')!
    expect(moved.frameId).toBeNull()
    expect(moved.x).toBe(10)
    expect(mocks.revert).toHaveBeenCalledTimes(1)
  })

  it('offers, but does not perform, removal when a card is dragged out', async () => {
    const { commit } = mount([card('c1', 'f1'), boundFrame])
    commit([card('c1', null, 2000), boundFrame])
    await flush()

    expect(mocks.remove).not.toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalledTimes(1)
    const [, options] = mocks.toast.mock.calls[0] as [string, { action: { onClick: () => void } }]
    mocks.remove.mockResolvedValue({ status: 'applied', revert: vi.fn() })
    act(() => options.action.onClick())
    await flush()
    expect(mocks.remove).toHaveBeenCalledWith({ entityType: 'note', entityId: 'n-c1' }, tag)
  })

  it('reverts the write when Excalidraw undo takes the card back out', async () => {
    const { commit } = mount([card('c1', null), boundFrame])
    commit([card('c1', 'f1', 600), boundFrame])
    await flush()

    fireEvent.keyDown(document, { key: 'z', metaKey: true })
    commit([card('c1', null), boundFrame])
    await flush()

    expect(mocks.revert).toHaveBeenCalledTimes(1)
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('writes nothing in view mode', async () => {
    const { commit } = mount([card('c1', null), boundFrame], false)
    commit([card('c1', 'f1', 600), boundFrame])
    await flush()
    expect(mocks.apply).not.toHaveBeenCalled()
  })

  it('ignores cards entering an unbound frame', async () => {
    const plain = { ...boundFrame, customData: null }
    const { commit } = mount([card('c1', null), plain])
    commit([card('c1', 'f1', 600), plain])
    await flush()
    expect(mocks.apply).not.toHaveBeenCalled()
  })

  it('binds a selected plain frame and categorizes the cards already inside', async () => {
    const plain = { ...boundFrame, customData: null, name: null }
    const { scene, onSceneMutated } = mount([card('c1', 'f1'), plain], true, { f1: true })
    fireEvent.click(screen.getByTestId('canvas-frame-chip-f1'))
    expect(mocks.bindingDialog?.open).toBe(true)

    act(() => mocks.bindingDialog!.onPick(tag))
    await flush()

    const frame = scene.elements.find((el) => el.id === 'f1')!
    expect(frame.customData).toEqual({ [FRAME_BINDING_KEY]: tag })
    expect(frame.name).toBe('#health/sleep')
    expect(onSceneMutated).toHaveBeenCalled()
    expect(mocks.apply).toHaveBeenCalledWith({ entityType: 'note', entityId: 'n-c1' }, tag)

    // Undo reverts the write but leaves the card where it is.
    const [, options] = mocks.toast.success.mock.calls[0] as [
      string,
      { action: { onClick: () => void } }
    ]
    act(() => options.action.onClick())
    await flush()
    expect(mocks.revert).toHaveBeenCalledTimes(1)
    expect(scene.elements.find((el) => el.id === 'c1')!.frameId).toBe('f1')
  })

  it('unbinding keeps a name the user chose and strips nothing from cards', async () => {
    const named = { ...boundFrame, name: 'My section' }
    const { scene } = mount([card('c1', 'f1'), named])
    fireEvent.click(screen.getByTestId('canvas-frame-chip-f1'))
    act(() => mocks.bindingDialog!.onUnbind())
    await flush()
    const frame = scene.elements.find((el) => el.id === 'f1')!
    expect(frame.customData).toBeNull()
    expect(frame.name).toBe('My section')
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(screen.queryByTestId('canvas-frame-chip-f1')).toBeNull()
  })

  it('reports skipped cards and failed writes', async () => {
    mocks.apply
      .mockResolvedValueOnce({ status: 'skipped', reason: 'file' })
      .mockRejectedValueOnce(new Error('disk full'))
    const { commit } = mount([card('c1', null), card('c2', null), boundFrame])
    commit([card('c1', 'f1'), card('c2', 'f1'), boundFrame])
    await flush()
    await flush()
    expect(mocks.toast).toHaveBeenCalledWith('canvas.frame.skippedFile {"count":1}')
    expect(mocks.toast.error).toHaveBeenCalledWith('disk full')
    expect(mocks.toast.success).not.toHaveBeenCalled()
  })

  it('lays the board out by property into new bound frames', async () => {
    mocks.propsGet.mockImplementation(async (id: string) =>
      id === 'n-c1' ? [{ name: 'Status', value: 'Done', type: 'status' }] : []
    )
    const { scene, api } = mount([card('c1', null), card('c2', null, 400)])
    await act(async () => {
      mocks.layoutDialog!.onPick({ name: 'Status', type: 'status', values: ['Todo', 'Done'] })
    })
    await flush()

    const frames = scene.elements.filter((el) => el.type === 'frame')
    expect(frames.map((f) => f.name)).toEqual(['Status: Todo', 'Status: Done'])
    const moved = scene.elements.find((el) => el.id === 'c1')!
    expect(moved.frameId).toBe(frames[1].id)
    // The frame's children sit right before it.
    const ids = scene.elements.map((el) => el.id)
    expect(ids.indexOf('c1')).toBe(ids.indexOf(frames[1].id) - 1)
    expect(scene.elements.find((el) => el.id === 'c2')!.frameId).toBeNull()
    expect(api.scrollToContent).toHaveBeenCalled()
    // Laying out is not a drop: nothing is written to notes.
    expect(mocks.apply).not.toHaveBeenCalled()
    expect(mocks.toast.success).toHaveBeenCalledTimes(1)
  })
})
