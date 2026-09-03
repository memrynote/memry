/**
 * What the surface actually does: the toolbar's actions, and the link
 * affordance the map draws for itself.
 *
 * The drawing library stands in for itself here: jsdom has no canvas to
 * rasterise to and no system clipboard to write to, so the real
 * `exportToBlob`/`exportToSvg` could not run and the real `navigator.clipboard`
 * does not exist. The stand-in is faithful in the two places that matter — it
 * hands up a live scene the exports read, and it converts viewport points to
 * scene points the same way the library does — so what these tests prove is the
 * wiring, which is where this kind of code has gone wrong before: that an
 * export reads the LIVE scene rather than the elements the map was built from,
 * that the export settings are pinned rather than inherited from the app's
 * theme or the user's camera, that a failure travels up to the caller, and that
 * the hover and the click land on the box the pointer is actually over.
 *
 * They deliberately do not prove that the resulting bytes are a valid PNG, that
 * a real clipboard accepts them, or that a real Excalidraw canvas puts its
 * pixels where this arithmetic says it does — only a real browser can say that.
 */

import { useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { exportToBlob, exportToSvg } from '@excalidraw/excalidraw'
import { MindMapCanvas, type MindMapControls, type MindMapHoverLabel } from './mind-map-canvas'
import type { MindMapElement } from './mind-map-types'

/**
 * The scene the surface is showing — deliberately NOT the elements the map was
 * built from, so a test can tell the two apart. A branch the user expanded
 * lives here and nowhere else.
 *
 * Real geometry and real `customData`, because the hit test reads both off this
 * same live scene: the library regenerates every id on the way in, so
 * `customData` is the only field a box's address can survive in.
 */
const ROOT_HREF = 'memry://note/n1'
const ITEM_HREF = 'memry://note/n1#^b-item'
const WIKI_HREF = 'memry://note/n1#^mm-b-item-link-1'

const LIVE_ELEMENTS = [
  { id: 'live-1', x: 0, y: 0, width: 100, height: 40, customData: { memryHref: ROOT_HREF } },
  { id: 'live-2', x: 200, y: 0, width: 160, height: 40, customData: { memryHref: ITEM_HREF } },
  { id: 'live-3', x: 200, y: 100, width: 160, height: 40, customData: { memryHref: WIKI_HREF } },
  /** A connector: no address, so the hit test must never answer with it. */
  { id: 'live-edge', x: 0, y: 0, width: 400, height: 400 }
]
const LIVE_FILES = { 'file-1': { id: 'file-1' } }

const HOVER_LABELS: ReadonlyMap<string, MindMapHoverLabel> = new Map([
  [ROOT_HREF, { chain: 'Test Note', hint: null }],
  [ITEM_HREF, { chain: '\u2026 \u2192 Q3 Risks \u2192 Hire a designer', hint: null }],
  [WIKI_HREF, { chain: 'Roadmap \u2192 Q3', hint: 'link to another page' }]
])

const mocks = vi.hoisted(() => ({
  scrollToContent: vi.fn(),
  updateScene: vi.fn(),
  /** Takes the handler, so a test can drive a camera change by calling it. */
  onChange: vi.fn((_handler: () => void) => () => {}),
  /** The camera, as a test can move it. */
  appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 }, offsetLeft: 0, offsetTop: 0 }
}))

vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: ({ excalidrawAPI }: { excalidrawAPI: (api: Record<string, unknown>) => void }) => {
    useEffect(() => {
      excalidrawAPI({
        getSceneElements: () => LIVE_ELEMENTS,
        getFiles: () => LIVE_FILES,
        getAppState: () => mocks.appState,
        onChange: mocks.onChange,
        updateScene: mocks.updateScene,
        scrollToContent: mocks.scrollToContent
      })
    }, [excalidrawAPI])
    return <div data-testid="excalidraw" />
  },
  convertToExcalidrawElements: (elements: unknown[]) => elements,
  // The library's own arithmetic, kept honest rather than stubbed: the hit test
  // is only as right as this conversion.
  viewportCoordsToSceneCoords: (
    point: { clientX: number; clientY: number },
    appState: { scrollX: number; scrollY: number; zoom: { value: number } }
  ) => ({
    x: point.clientX / appState.zoom.value - appState.scrollX,
    y: point.clientY / appState.zoom.value - appState.scrollY
  }),
  exportToBlob: vi.fn(),
  exportToSvg: vi.fn()
}))

class FakeClipboardItem {
  constructor(readonly items: Record<string, Blob>) {}
}

const clipboard = { write: vi.fn(), writeText: vi.fn() }

/** #1670's link forwarding; irrelevant to an export, but the surface takes it. */
const openLink = vi.fn()

/** The elements the map was built from; a copy must not reach for these. */
const BUILT_ELEMENTS = [
  { type: 'rectangle', id: 'built-1' }
] as unknown as readonly MindMapElement[]

function mountSurface(
  initialFocusHref: string | null = null
): { controls: () => MindMapControls; unmount: () => void } {
  let latest: MindMapControls | null = null
  const view = render(
    <MindMapCanvas
      elements={BUILT_ELEMENTS}
      hoverLabels={HOVER_LABELS}
      onOpenLink={openLink}
      initialFocusHref={initialFocusHref}
      onControlsChange={(next) => {
        latest = next
      }}
    />
  )
  return {
    controls: () => {
      if (!latest) throw new Error('the drawing surface handed no controls up')
      return latest
    },
    unmount: view.unmount
  }
}

/** The drawing itself, which is what a pointer event on the canvas reaches. */
function drawing(): HTMLElement {
  return screen.getByTestId('excalidraw')
}

function pointAt(x: number, y: number): void {
  fireEvent.pointerMove(drawing(), { clientX: x, clientY: y })
}

function clickAt(x: number, y: number): void {
  fireEvent.pointerDown(drawing(), { clientX: x, clientY: y })
  fireEvent.click(drawing(), { clientX: x, clientY: y })
}

function card(): HTMLElement | null {
  return screen.queryByTestId('mind-map-hover-card')
}

describe('MindMapCanvas controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.onChange.mockImplementation(() => () => {})
    mocks.appState = { scrollX: 0, scrollY: 0, zoom: { value: 1 }, offsetLeft: 0, offsetTop: 0 }
    vi.stubGlobal('ClipboardItem', FakeClipboardItem)
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: clipboard,
      configurable: true,
      writable: true
    })
    vi.mocked(exportToBlob).mockResolvedValue(new Blob(['png-bytes'], { type: 'image/png' }))
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('data-map', 'yes')
    vi.mocked(exportToSvg).mockResolvedValue(svg)
  })

  it('hands its controls up while it is live and takes them back when it is not', () => {
    let latest: MindMapControls | null | undefined
    const view = render(
      <MindMapCanvas
        elements={BUILT_ELEMENTS}
        hoverLabels={HOVER_LABELS}
        onOpenLink={openLink}
        onControlsChange={(next) => {
          latest = next
        }}
      />
    )
    expect(latest).toEqual({
      fit: expect.any(Function),
      focus: expect.any(Function),
      copyImage: expect.any(Function),
      copyVector: expect.any(Function)
    })

    view.unmount()
    expect(latest).toBeNull()
  })

  it('opens framed whole when the reader had nowhere in particular to be', () => {
    mountSurface(null)

    expect(mocks.scrollToContent).toHaveBeenCalledTimes(1)
    expect(mocks.scrollToContent).toHaveBeenCalledWith(undefined, {
      fitToContent: true,
      animate: false
    })
  })

  it('opens on the section the reader was in, in the same frame as the fit', () => {
    mountSurface(ITEM_HREF)

    // The fit is what decides the ZOOM — there is no other source for a
    // sensible one — and the centring lands on top of it before anything is
    // painted, so the whole-map view is never something the user sees go past.
    expect(mocks.scrollToContent.mock.calls).toEqual([
      [undefined, { fitToContent: true, animate: false }],
      [LIVE_ELEMENTS[1], { animate: false }]
    ])
  })

  it('falls back to the whole drawing when the block it was aimed at was not drawn', () => {
    // A heading folded behind a "+N more", or dropped at the node cap: the map
    // is still worth showing, just not from there.
    mountSurface('memry://note/n1#^b-never-drawn')

    expect(mocks.scrollToContent).toHaveBeenCalledTimes(1)
    expect(mocks.scrollToContent).toHaveBeenCalledWith(undefined, {
      fitToContent: true,
      animate: false
    })
  })

  it('centres on one box on focus, and leaves the zoom exactly where it was', () => {
    const surface = mountSurface()
    mocks.scrollToContent.mockClear()

    expect(surface.controls().focus(WIKI_HREF)).toBe(true)

    // NEITHER fit option is passed, and that is the whole point: with one, the
    // library would rescale the picture and take away the reading distance the
    // user chose from the outline panel they clicked in.
    // The flight is pinned rather than left to the library's default, because
    // the ring that marks the arrival has to outlast it.
    expect(mocks.scrollToContent).toHaveBeenCalledWith(LIVE_ELEMENTS[2], {
      animate: true,
      duration: 250
    })
  })

  it('rings the box it focused, so the reader can see what the click landed on', () => {
    const surface = mountSurface()

    act(() => {
      surface.controls().focus(WIKI_HREF)
    })

    // The box's own rectangle, through the camera: `(scene + scroll) * zoom`,
    // which at rest is the scene rectangle itself.
    const ring = screen.getByTestId('mind-map-focus-ring')
    expect(ring).toHaveStyle({ left: '200px', top: '100px', width: '160px', height: '40px' })
    // Decoration on the picture: the outline entry the reader pressed already
    // named this node in words.
    expect(ring.parentElement).toHaveAttribute('aria-hidden', 'true')
  })

  it('keeps the ring glued to its box while the camera is still flying', async () => {
    // The camera reports every committed change, a pan tick included, which is
    // what the ring rides: measured once at the click it would sit where the
    // box used to be for the whole flight.
    let notify: (() => void) | undefined
    mocks.onChange.mockImplementation((handler: () => void) => {
      notify = handler
      return () => {}
    })
    const surface = mountSurface()

    act(() => {
      surface.controls().focus(WIKI_HREF)
    })
    expect(screen.getByTestId('mind-map-focus-ring')).toHaveStyle({ left: '200px' })

    mocks.appState = { scrollX: -100, scrollY: 0, zoom: { value: 2 }, offsetLeft: 0, offsetTop: 0 }
    await act(async () => {
      notify?.()
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })

    // `(200 - 100) * 2`, the same transform the affordance anchor uses.
    expect(screen.getByTestId('mind-map-focus-ring')).toHaveStyle({
      left: '200px',
      top: '200px',
      width: '320px',
      height: '80px'
    })
  })

  it('drops the ring once the flash is over', async () => {
    vi.useFakeTimers()
    try {
      const surface = mountSurface()
      act(() => {
        surface.controls().focus(WIKI_HREF)
      })
      expect(screen.getByTestId('mind-map-focus-ring')).toBeInTheDocument()

      act(() => {
        vi.advanceTimersByTime(600)
      })

      // Unmounted rather than left at zero opacity, so the next focus animates
      // from the start instead of showing a ring that never fades.
      expect(screen.queryByTestId('mind-map-focus-ring')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('moves the ring to the second box when a second heading is clicked', () => {
    const surface = mountSurface()

    act(() => {
      surface.controls().focus(WIKI_HREF)
    })
    act(() => {
      surface.controls().focus(ITEM_HREF)
    })

    // One ring, on the box the reader asked for last.
    expect(screen.getAllByTestId('mind-map-focus-ring')).toHaveLength(1)
    expect(screen.getByTestId('mind-map-focus-ring')).toHaveStyle({ top: '0px' })
  })

  it('answers false for a box that is not on the live scene, and moves nothing', () => {
    const surface = mountSurface()
    mocks.scrollToContent.mockClear()

    // False is what lets the outline panel fall back to opening the note at
    // that heading rather than swallowing the click.
    expect(surface.controls().focus('memry://note/n1#^b-never-drawn')).toBe(false)
    expect(mocks.scrollToContent).not.toHaveBeenCalled()
  })

  it('frames the whole drawing on fit, wherever the user panned to', () => {
    const surface = mountSurface()
    mocks.scrollToContent.mockClear()

    act(() => surface.controls().fit())

    expect(mocks.scrollToContent).toHaveBeenCalledWith(undefined, {
      fitToContent: true,
      animate: true
    })
  })

  it('copies the live scene as an image, not the elements the map was built from', async () => {
    const surface = mountSurface()

    await act(async () => await surface.controls().copyImage())

    expect(vi.mocked(exportToBlob).mock.calls[0][0]).toMatchObject({
      elements: LIVE_ELEMENTS,
      files: LIVE_FILES,
      mimeType: 'image/png'
    })
    expect(vi.mocked(exportToBlob).mock.calls[0][0].elements).not.toBe(BUILT_ELEMENTS)

    const [items] = clipboard.write.mock.calls[0] as [FakeClipboardItem[]]
    expect(items[0]).toBeInstanceOf(FakeClipboardItem)
    expect(items[0].items['image/png']).toBeInstanceOf(Blob)
  })

  it('copies the live scene as SVG markup, which the sanitized clipboard carries as text', async () => {
    const surface = mountSurface()

    await act(async () => await surface.controls().copyVector())

    expect(vi.mocked(exportToSvg).mock.calls[0][0]).toMatchObject({
      elements: LIVE_ELEMENTS,
      files: LIVE_FILES
    })
    expect(clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('data-map="yes"'))
    expect(clipboard.write).not.toHaveBeenCalled()
  })

  it('pins the export settings instead of inheriting the theme or the camera', async () => {
    const surface = mountSurface()

    await act(async () => await surface.controls().copyImage())
    await act(async () => await surface.controls().copyVector())

    // The map's colours are authored light, so the same note copies the same
    // way whichever theme the app is in, and drops onto any background.
    for (const call of [
      vi.mocked(exportToBlob).mock.calls[0][0],
      vi.mocked(exportToSvg).mock.calls[0][0]
    ]) {
      expect(call.appState).toMatchObject({
        exportBackground: false,
        exportWithDarkMode: false,
        exportEmbedScene: false
      })
      expect(call.appState).not.toHaveProperty('scrollX')
      expect(call.appState).not.toHaveProperty('zoom')
    }
  })

  it('lets a failed copy travel up, so the host can say something about it', async () => {
    vi.mocked(exportToBlob).mockRejectedValue(new Error('Rasterising failed'))
    const surface = mountSurface()

    await expect(surface.controls().copyImage()).rejects.toThrow('Rasterising failed')
    expect(clipboard.write).not.toHaveBeenCalled()
  })
})

/**
 * The affordance the map draws for itself, now that its boxes carry no `link`
 * for the library to decorate.
 *
 * What is asserted is the wiring and the arithmetic — which box a point lands
 * on, what is said about it, and that a click reaches the same box. What jsdom
 * cannot say is whether the card lands over the right pixels on a real canvas;
 * the numbers are checked here, the picture is not.
 */
describe('MindMapCanvas link affordance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.onChange.mockImplementation(() => () => {})
    mocks.appState = { scrollX: 0, scrollY: 0, zoom: { value: 1 }, offsetLeft: 0, offsetTop: 0 }
  })

  it('says nothing until the pointer is over a node', () => {
    mountSurface()
    expect(card()).toBeNull()

    // Inside the connector's bounds but on no box: an element with no address
    // is not a node, however large it is.
    pointAt(150, 60)
    expect(card()).toBeNull()
  })

  it('names the node under the cursor, and only that node', () => {
    mountSurface()

    pointAt(240, 20)
    expect(card()).toHaveTextContent('\u2026 \u2192 Q3 Risks \u2192 Hire a designer')
    expect(card()).not.toHaveTextContent('Test Note')

    pointAt(50, 20)
    expect(card()).toHaveTextContent('Test Note')
    expect(card()).not.toHaveTextContent('Q3 Risks')
  })

  it('answers for the whole box, not for a glyph in the corner of it', () => {
    mountSurface()

    // Every corner and the middle of live-2 (200,0 → 360,40). This is the
    // property view mode's own link hit test gave us and the one thing a
    // re-implementation could quietly take away.
    for (const [x, y] of [
      [200, 0],
      [360, 0],
      [200, 40],
      [360, 40],
      [280, 20]
    ]) {
      pointAt(x, y)
      expect(card()).toHaveTextContent('Hire a designer')
    }

    // One pixel past the edge is not the box.
    pointAt(361, 20)
    expect(card()).toBeNull()
  })

  it('says when the link leaves this note, in the tree\u2019s own words', () => {
    mountSurface()

    pointAt(280, 120)
    expect(card()).toHaveTextContent('Roadmap \u2192 Q3')
    expect(card()).toHaveTextContent('link to another page')
  })

  it('is decoration on the picture rather than a second thing to read', () => {
    mountSurface()
    pointAt(280, 20)

    // The accessible tree beside the map already carries this in words; a
    // second copy would be read out twice. It is also never a pointer target —
    // every event has to reach the drawing underneath it.
    const layer = card()!.parentElement!
    expect(layer).toHaveAttribute('aria-hidden', 'true')
    expect(layer.className).toContain('pointer-events-none')
  })

  it('turns the cursor into a pointer only while a node is under it', () => {
    const { container } = render(
      <MindMapCanvas elements={BUILT_ELEMENTS} hoverLabels={HOVER_LABELS} onOpenLink={openLink} />
    )
    const wrapper = container.querySelector('.mind-map-surface')!
    expect(wrapper).not.toHaveAttribute('data-node-hover')

    pointAt(280, 20)
    // The rule itself lives in CSS, because only a rule marked important
    // outranks the inline cursor the library sets on its own canvas.
    expect(wrapper).toHaveAttribute('data-node-hover', 'true')

    pointAt(500, 500)
    expect(wrapper).not.toHaveAttribute('data-node-hover')
  })

  it('follows the camera, so a pan does not leave the answer behind', () => {
    mountSurface()

    pointAt(240, 20)
    expect(card()).toHaveTextContent('Hire a designer')

    // The pointer has not moved; the drawing has. The same screen point is now
    // over the root's box.
    mocks.appState = { ...mocks.appState, scrollX: 200 }
    pointAt(240, 20)
    expect(card()).toHaveTextContent('Test Note')
  })

  it('opens what the box under the click points at, from anywhere in the box', () => {
    mountSurface()

    clickAt(205, 38)
    expect(openLink).toHaveBeenCalledWith(ITEM_HREF)

    clickAt(20, 20)
    expect(openLink).toHaveBeenLastCalledWith(ROOT_HREF)

    // A wiki-link box is handed back exactly like any other: WHERE it goes is
    // decided downstream, from the node its href resolves to.
    clickAt(280, 120)
    expect(openLink).toHaveBeenLastCalledWith(WIKI_HREF)
  })

  it('opens nothing when the click lands on no box', () => {
    mountSurface()

    clickAt(150, 60)
    expect(openLink).not.toHaveBeenCalled()
  })

  it('treats a press that travelled as a pan rather than as a click', () => {
    mountSurface()

    // In view mode a drag anywhere moves the camera, and finishing a pan over
    // a node must not open it.
    fireEvent.pointerDown(drawing(), { clientX: 210, clientY: 20 })
    fireEvent.click(drawing(), { clientX: 300, clientY: 20 })
    expect(openLink).not.toHaveBeenCalled()
  })

  it('forgets what was under the cursor when the map is rebuilt', () => {
    const view = render(
      <MindMapCanvas elements={BUILT_ELEMENTS} hoverLabels={HOVER_LABELS} onOpenLink={openLink} />
    )
    pointAt(240, 20)
    expect(card()).not.toBeNull()

    // A rebuilt map is a different drawing; whatever was under the cursor
    // belonged to the old one.
    view.rerender(
      <MindMapCanvas
        elements={[{ type: 'rectangle', id: 'built-2' }] as unknown as readonly MindMapElement[]}
        hoverLabels={HOVER_LABELS}
        onOpenLink={openLink}
      />
    )
    expect(card()).toBeNull()
  })
})
