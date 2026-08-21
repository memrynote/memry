/**
 * What the toolbar's actions actually do to the drawing.
 *
 * The drawing library stands in for itself here: jsdom has no canvas to
 * rasterise to and no system clipboard to write to, so the real
 * `exportToBlob`/`exportToSvg` could not run and the real `navigator.clipboard`
 * does not exist. What these tests can prove is the part that has been wrong
 * before in this kind of code: that an export reads the LIVE scene rather than
 * the elements the map was built from, that the export settings are pinned
 * rather than inherited from the app's theme or the user's camera, and that a
 * failure travels up to the caller instead of being swallowed here.
 *
 * They deliberately do not prove that the resulting bytes are a valid PNG or
 * that a real clipboard accepts them — only a real browser can say that.
 */

import { useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { exportToBlob, exportToSvg } from '@excalidraw/excalidraw'
import { MindMapCanvas, type MindMapControls } from './mind-map-canvas'
import type { MindMapElement } from './mind-map-types'

/**
 * The scene the surface is showing — deliberately NOT the elements the map was
 * built from, so a test can tell the two apart. A branch the user expanded
 * lives here and nowhere else.
 */
const LIVE_ELEMENTS = [{ id: 'live-1' }, { id: 'live-2' }]
const LIVE_FILES = { 'file-1': { id: 'file-1' } }

const mocks = vi.hoisted(() => ({
  scrollToContent: vi.fn(),
  updateScene: vi.fn()
}))

vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: ({ excalidrawAPI }: { excalidrawAPI: (api: Record<string, unknown>) => void }) => {
    useEffect(() => {
      excalidrawAPI({
        getSceneElements: () => LIVE_ELEMENTS,
        getFiles: () => LIVE_FILES,
        updateScene: mocks.updateScene,
        scrollToContent: mocks.scrollToContent
      })
    }, [excalidrawAPI])
    return <div data-testid="excalidraw" />
  },
  convertToExcalidrawElements: (elements: unknown[]) => elements,
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

function mountSurface(): { controls: () => MindMapControls; unmount: () => void } {
  let latest: MindMapControls | null = null
  const view = render(
    <MindMapCanvas
      elements={BUILT_ELEMENTS}
      onOpenLink={openLink}
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

describe('MindMapCanvas controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
        onOpenLink={openLink}
        onControlsChange={(next) => {
          latest = next
        }}
      />
    )
    expect(latest).toEqual({
      fit: expect.any(Function),
      copyImage: expect.any(Function),
      copyVector: expect.any(Function)
    })

    view.unmount()
    expect(latest).toBeNull()
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
