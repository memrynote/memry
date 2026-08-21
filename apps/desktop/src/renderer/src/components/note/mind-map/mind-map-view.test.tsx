/**
 * The map's controls, as a reader and a user meet them.
 *
 * A real render of the real toolbar against the real English strings — the only
 * thing standing in for something else here is the drawing surface itself,
 * which imports a library that cannot draw in jsdom. That stub hands its
 * controls up exactly as the real chunk does, so what is asserted is the wiring
 * between the toolbar and whatever surface is live.
 */

import { useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { buildMindMap } from './build-mind-map'
import { MindMapView } from './mind-map-view'
import type { MindMapSourceBlock } from './mind-map-types'

const mocks = vi.hoisted(() => ({
  fit: vi.fn(),
  copyImage: vi.fn(),
  copyVector: vi.fn(),
  /** False to hold the surface back, as a chunk that has not arrived yet. */
  handsControlsUp: true,
  toCanvasScene: vi.fn((elements: readonly unknown[]) => JSON.stringify({ elements })),
  create: vi.fn(),
  list: vi.fn(),
  resolveWikiLink: vi.fn(),
  hoverLabels: new Map<string, { chain: string; hint: string | null }>() as ReadonlyMap<
    string,
    { chain: string; hint: string | null }
  >
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// The drawing library cannot initialize under jsdom, and this module imports
// it. What the save action puts INTO a canvas is asserted without any of that,
// purely, in `mind-map-snapshot.test.ts`; what is asserted here is the wiring —
// which document, under which name, and what the user is told when it fails.
vi.mock('./mind-map-export', () => ({ toCanvasScene: mocks.toCanvasScene }))

vi.mock('@/services/canvas-service', () => ({
  canvasService: { create: mocks.create, list: mocks.list }
}))

// The real one, standing in for the database behind it: a wiki target is a
// title, and only a lookup turns one into an id. What matters here is that the
// save path asks it at all, and asks the same resolver a `[[…]]` in the body
// asks.
vi.mock('@/lib/wikilink-resolver', () => ({ resolveWikiLink: mocks.resolveWikiLink }))

vi.mock('./mind-map-canvas', () => ({
  MindMapCanvas: ({
    hoverLabels,
    onControlsChange
  }: {
    hoverLabels: ReadonlyMap<string, { chain: string; hint: string | null }>
    onControlsChange?: (controls: Record<string, unknown> | null) => void
  }) => {
    // What the surface was handed, so a test can read it without a canvas.
    mocks.hoverLabels = hoverLabels
    useEffect(() => {
      if (!mocks.handsControlsUp) return
      onControlsChange?.({
        fit: mocks.fit,
        copyImage: mocks.copyImage,
        copyVector: mocks.copyVector
      })
      return () => onControlsChange?.(null)
    }, [onControlsChange])
    return <div data-testid="mind-map-canvas" />
  }
}))

/** The slice of a saved element these assertions read. */
interface SavedElement {
  type: string
  id: string
  link?: string
  strokeStyle?: string
  customData?: { memryHref?: string }
}

/**
 * Where a saved box carries its deep link.
 *
 * `customData`, never `element.link`: that field is what the drawing library
 * paints its permanent glyph from, and a map is nothing but linked boxes.
 */
function hrefOf(element: SavedElement): string | undefined {
  return element.customData?.memryHref
}

const BLOCKS: MindMapSourceBlock[] = [
  { id: 'b-h1', type: 'heading', props: { level: 1 }, content: [{ type: 'text', text: 'Alpha' }] }
]

const activateNode = vi.fn()

function renderView(blocks: MindMapSourceBlock[] = BLOCKS): ReturnType<typeof render> {
  return render(
    <MindMapView
      map={buildMindMap(blocks, { rootLabel: 'Test Note', noteId: 'note-1' })}
      noteId="note-1"
      noteTitle="Test Note"
      onActivateNode={activateNode}
    />
  )
}

async function renderMap(): Promise<HTMLElement> {
  renderView()
  return await screen.findByRole('toolbar')
}

describe('MindMapView toolbar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.handsControlsUp = true
    mocks.copyImage.mockResolvedValue(undefined)
    mocks.copyVector.mockResolvedValue(undefined)
    mocks.toCanvasScene.mockImplementation((elements: readonly unknown[]) =>
      JSON.stringify({ elements })
    )
    mocks.list.mockResolvedValue({ canvases: [] })
    mocks.create.mockResolvedValue({ id: 'canvas-1' })
    mocks.resolveWikiLink.mockResolvedValue({ type: 'not-found', id: '', heading: null })
  })

  it('offers fit and both copies, translated, in the map and outside its picture', async () => {
    const toolbar = await renderMap()

    expect(toolbar).toHaveAccessibleName('Mind map actions')
    expect(
      within(toolbar)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label'))
    ).toEqual(['Fit to view', 'Copy as image', 'Copy as vector', 'Save as canvas'])
    // Every control is also its own tooltip.
    for (const button of within(toolbar).getAllByRole('button')) {
      expect(button).toHaveAttribute('title', button.getAttribute('aria-label'))
    }

    // Inside the map, but NOT inside the drawing's image role: an image role
    // makes its contents presentational, which would hide these controls from
    // the readers the accessible projection beside them exists for.
    expect(screen.getByTestId('note-mind-map')).toContainElement(toolbar)
    expect(screen.getByRole('img')).not.toContainElement(toolbar)
  })

  it('leaves the surface-bound controls inert until the drawing surface is live', async () => {
    mocks.handsControlsUp = false
    const toolbar = await renderMap()

    for (const button of within(toolbar).getAllByRole('button')) {
      // Saving is the exception: its document is minted from the map's own
      // descriptors, so it never waits on a chunk to arrive.
      const expected = button.getAttribute('aria-label') !== 'Save as canvas'
      expect(button.hasAttribute('disabled')).toBe(expected)
    }
  })

  it('frames the live drawing again on fit', async () => {
    await renderMap()

    fireEvent.click(screen.getByRole('button', { name: 'Fit to view' }))
    expect(mocks.fit).toHaveBeenCalledTimes(1)
  })

  it('copies through the live surface and says so', async () => {
    await renderMap()

    fireEvent.click(screen.getByRole('button', { name: 'Copy as image' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Map copied as an image'))
    expect(mocks.copyImage).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Copy as vector' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Map copied as vector artwork'))
    expect(mocks.copyVector).toHaveBeenCalledTimes(1)
  })

  it('says a copy failed rather than failing quietly', async () => {
    mocks.copyImage.mockRejectedValue(new Error('Clipboard blocked'))
    await renderMap()

    fireEvent.click(screen.getByRole('button', { name: 'Copy as image' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Clipboard blocked'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('falls back to a translated message when the failure carries none', async () => {
    mocks.copyVector.mockRejectedValue(undefined)
    await renderMap()

    fireEvent.click(screen.getByRole('button', { name: 'Copy as vector' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to copy the map'))
  })

  it('says nothing about a limit the note never reaches', async () => {
    await renderMap()

    // The region is there — it has to already exist for a screen reader to
    // announce it later — but it says nothing.
    expect(screen.getByTestId('note-mind-map-cap-notice')).toBeEmptyDOMElement()
  })

  it('says the map is at its limit, above the picture and outside it', async () => {
    // Wide and deep enough that the whole-map budget runs out on it.
    const section = (id: string, level: number, text: string): MindMapSourceBlock => ({
      id,
      type: 'heading',
      props: { level },
      content: [{ type: 'text', text }]
    })
    const huge: MindMapSourceBlock[] = Array.from({ length: 12 }, (_, top) => [
      section(`h1-${top}`, 1, `Section ${top}`),
      ...Array.from({ length: 12 }, (_, mid) => [
        section(`h2-${top}-${mid}`, 2, `Part ${top}.${mid}`),
        {
          id: `b-${top}-${mid}`,
          type: 'bulletListItem',
          content: [{ type: 'text', text: `Item ${top}.${mid}` }]
        }
      ]).flat()
    ]).flat()
    renderView(huge)

    const notice = await screen.findByTestId('note-mind-map-cap-notice')
    // Translated, and a live region so it also arrives when expanding a branch
    // is what spent the last of the budget.
    expect(notice).toHaveTextContent('This map is at its limit of 200 nodes')
    expect(notice).toHaveAttribute('role', 'status')
    // Above the drawing and never inside it: an image role makes its contents
    // presentational, so a notice nested in it would reach nobody.
    expect(screen.getByTestId('note-mind-map')).toContainElement(notice)
    expect(screen.getByRole('img')).not.toContainElement(notice)
    expect(notice.compareDocumentPosition(screen.getByRole('img'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
  })

  it('mints a canvas at the root, named after the note, and says so', async () => {
    await renderMap()

    fireEvent.click(screen.getByRole('button', { name: 'Save as canvas' }))
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1))

    const input = mocks.create.mock.calls[0][0] as {
      title: string
      folder: string | null
      scene: string
    }
    // The canvas ROOT: the note's folder tree is deliberately not mirrored.
    expect(input.folder).toBeNull()
    expect(input.title).toBe('Test Note')
    expect(JSON.parse(input.scene)).toHaveProperty('elements')
    expect(toast.success).toHaveBeenCalledWith('Saved as the canvas \u201cTest Note\u201d')
  })

  it('suffixes the title when the canvas root already holds that name', async () => {
    mocks.list.mockResolvedValue({
      canvases: [
        { id: 'c1', title: 'Test Note', folder: null },
        { id: 'c2', title: 'test note 2', folder: null },
        // A same-named canvas in a FOLDER is not a collision: only the root is.
        { id: 'c3', title: 'Test Note 3', folder: 'Work' }
      ]
    })
    await renderMap()

    fireEvent.click(screen.getByRole('button', { name: 'Save as canvas' }))
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1))
    expect((mocks.create.mock.calls[0][0] as { title: string }).title).toBe('Test Note 3')
  })

  it('makes a SECOND canvas rather than replacing the first', async () => {
    await renderMap()

    fireEvent.click(screen.getByRole('button', { name: 'Save as canvas' }))
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1))

    // As the vault looks once the first save has landed.
    mocks.list.mockResolvedValue({ canvases: [{ id: 'c1', title: 'Test Note', folder: null }] })
    fireEvent.click(screen.getByRole('button', { name: 'Save as canvas' }))
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2))

    // Two creates, two names, and never an update: overwriting would destroy a
    // canvas the user may have spent an hour editing.
    expect((mocks.create.mock.calls[1][0] as { title: string }).title).toBe('Test Note 2')
    expect(
      mocks.create.mock.calls.every((call) => (call[0] as { id?: string }).id === undefined)
    ).toBe(true)
  })

  it('dates the root so the canvas announces that it is a snapshot', async () => {
    await renderMap()

    fireEvent.click(screen.getByRole('button', { name: 'Save as canvas' }))
    await waitFor(() => expect(mocks.toCanvasScene).toHaveBeenCalledTimes(1))

    const elements = mocks.toCanvasScene.mock.calls[0][0] as Array<{
      type: string
      id: string
      label?: { text: string }
    }>
    const root = elements.find((element) => element.id === 'mm-root')!
    expect(root.label?.text.split('\n')[1]).toMatch(/^Snapshot · .+/)
  })

  it('says a save failed rather than failing quietly', async () => {
    mocks.create.mockRejectedValue(new Error('Vault is read-only'))
    await renderMap()

    fireEvent.click(screen.getByRole('button', { name: 'Save as canvas' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Vault is read-only'))
    expect(toast.success).not.toHaveBeenCalled()

    // And the control comes back, so a transient failure is not a dead button.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save as canvas' })).not.toBeDisabled()
    )
  })

  it('falls back to a translated message when a failed save carries none', async () => {
    mocks.list.mockRejectedValue(undefined)
    await renderMap()

    fireEvent.click(screen.getByRole('button', { name: 'Save as canvas' }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to save the map as a canvas')
    )
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('resolves a wiki-link node to the note it names before writing the file', async () => {
    mocks.resolveWikiLink.mockResolvedValue({ type: 'note', id: 'n2', heading: 'Plan' })
    renderView([
      {
        id: 'b-h1',
        type: 'heading',
        props: { level: 1 },
        content: [{ type: 'text', text: 'Alpha' }]
      },
      {
        id: 'b-p',
        type: 'paragraph',
        content: [{ type: 'wikiLink', props: { target: 'Roadmap' } }]
      }
    ])
    await screen.findByRole('toolbar')

    fireEvent.click(screen.getByRole('button', { name: 'Save as canvas' }))
    await waitFor(() => expect(mocks.toCanvasScene).toHaveBeenCalledTimes(1))

    // Asked the same resolver a `[[…]]` in the note body goes through.
    expect(mocks.resolveWikiLink).toHaveBeenCalledWith('Roadmap')

    const elements = mocks.toCanvasScene.mock.calls[0][0] as SavedElement[]
    // The saved box opens the note it names, on any device — not a node id only
    // this session could have understood — and it says so in words, because the
    // affordance a canvas renders for it has nothing but the href to read.
    expect(
      elements.some((element) => hrefOf(element) === 'memry://note/n2?label=Roadmap#Plan')
    ).toBe(true)
    expect(elements.every((element) => !hrefOf(element)?.includes('#^'))).toBe(true)
  })

  it('names every saved link, so a canvas hovers as words rather than as a URL', async () => {
    renderView([
      {
        id: 'b-h1',
        type: 'heading',
        props: { level: 1 },
        content: [{ type: 'text', text: 'Q3 Risks' }]
      },
      {
        id: 'b-item',
        type: 'bulletListItem',
        content: [{ type: 'text', text: 'Hire a designer' }]
      }
    ])
    await screen.findByRole('toolbar')

    fireEvent.click(screen.getByRole('button', { name: 'Save as canvas' }))
    await waitFor(() => expect(mocks.toCanvasScene).toHaveBeenCalledTimes(1))

    const boxes = (mocks.toCanvasScene.mock.calls[0][0] as SavedElement[]).filter(
      (element) => element.type === 'rectangle'
    )

    // Every one of them, not just the interesting ones: a canvas with one URL
    // left in it still hovers as a URL.
    expect(boxes.length).toBeGreaterThan(0)
    for (const box of boxes) {
      expect(new URL(hrefOf(box)!).searchParams.get('label')).toBeTruthy()
    }

    const item = boxes.find((box) => box.id.endsWith('b-item'))!
    // The destination, as a chain: the section it lands in, then the row. The
    // separator is the only translated part.
    expect(new URL(hrefOf(item)!).searchParams.get('label')).toBe(
      '\u2026 \u2192 Q3 Risks \u2192 Hire a designer'
    )
    // And the label never disturbs the anchor, which is what actually resolves.
    expect(hrefOf(item)).toContain('#Q3%20Risks')
  })

  it('leaves `element.link` empty, so no saved box wears the library glyph', async () => {
    renderView([
      {
        id: 'b-h1',
        type: 'heading',
        props: { level: 1 },
        content: [{ type: 'text', text: 'Q3 Risks' }]
      }
    ])
    await screen.findByRole('toolbar')

    fireEvent.click(screen.getByRole('button', { name: 'Save as canvas' }))
    await waitFor(() => expect(mocks.toCanvasScene).toHaveBeenCalledTimes(1))

    // The glyph's only condition is `element.link`, hover-gated by nothing. A
    // saved map keeps its href in `customData` for exactly that reason, and
    // `CanvasEditor` renders the same hover affordance the drawn map does.
    const elements = mocks.toCanvasScene.mock.calls[0][0] as SavedElement[]
    expect(elements.some((element) => hrefOf(element) !== undefined)).toBe(true)
    expect(elements.every((element) => element.link === undefined)).toBe(true)
  })

  it('hands the drawing a name for every box it drew, keyed the way a click arrives', async () => {
    renderView([
      {
        id: 'b-h1',
        type: 'heading',
        props: { level: 1 },
        content: [{ type: 'text', text: 'Q3 Risks' }]
      },
      {
        id: 'b-p',
        type: 'paragraph',
        content: [{ type: 'wikiLink', props: { target: 'Roadmap' } }]
      }
    ])
    await screen.findByTestId('mind-map-canvas')

    // Keyed by href because that is what a box carries and what the hit test
    // hands back — the drawing has no node ids to give, the library having
    // regenerated every one of them.
    expect(
      [...mocks.hoverLabels.keys()].every((href) => href.startsWith('memry://note/note-1'))
    ).toBe(true)
    expect(mocks.hoverLabels.get('memry://note/note-1')).toEqual({
      chain: 'Test Note',
      hint: null
    })
    expect(mocks.hoverLabels.get('memry://note/note-1#^b-h1')).toEqual({
      chain: 'Test Note \u2192 Q3 Risks',
      hint: null
    })

    // A wiki node names the note it points AT, and says in words that it leaves
    // this one — the same sentence the accessible tree gives it.
    const wiki = [...mocks.hoverLabels.values()].find((label) => label.hint !== null)
    expect(wiki).toEqual({ chain: 'Roadmap', hint: 'link to another page' })
  })

  it('takes its controls back when the drawing surface goes away', async () => {
    const view = renderView()
    await screen.findByTestId('mind-map-canvas')

    view.unmount()
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
  })
})
