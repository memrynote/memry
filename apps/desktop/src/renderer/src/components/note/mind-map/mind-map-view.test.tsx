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
  handsControlsUp: true
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock('./mind-map-canvas', () => ({
  MindMapCanvas: ({
    onControlsChange
  }: {
    onControlsChange?: (controls: Record<string, unknown> | null) => void
  }) => {
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
  })

  it('offers fit and both copies, translated, in the map and outside its picture', async () => {
    const toolbar = await renderMap()

    expect(toolbar).toHaveAccessibleName('Mind map actions')
    expect(
      within(toolbar)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label'))
    ).toEqual(['Fit to view', 'Copy as image', 'Copy as vector'])
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

  it('leaves the controls inert until the drawing surface is live', async () => {
    mocks.handsControlsUp = false
    const toolbar = await renderMap()

    for (const button of within(toolbar).getAllByRole('button')) {
      expect(button).toBeDisabled()
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

  it('takes its controls back when the drawing surface goes away', async () => {
    const view = renderView()
    await screen.findByTestId('mind-map-canvas')

    view.unmount()
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
  })
})
