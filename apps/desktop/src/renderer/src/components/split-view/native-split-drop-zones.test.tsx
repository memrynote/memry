import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { flushSync } from 'react-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MEMRY_TAB_DRAG_MIME } from '@/lib/drag-mime'
import { NativeSplitDropZones } from './native-split-drop-zones'

const mocks = vi.hoisted(() => ({
  openTab: vi.fn(),
  splitView: vi.fn(() => 'new-group')
}))

vi.mock('@/contexts/tabs', () => ({
  useTabActions: () => ({ openTab: mocks.openTab, splitView: mocks.splitView })
}))

const tab = { type: 'file', title: 'report.pdf', path: '/file/f-1', entityId: 'f-1' }

const transfer = (withPayload = true) => ({
  types: withPayload ? [MEMRY_TAB_DRAG_MIME] : ['text/plain'],
  getData: (mime: string) => (mime === MEMRY_TAB_DRAG_MIME ? JSON.stringify(tab) : ''),
  dropEffect: 'none'
})

const startDrag = (): void => {
  act(() => {
    fireEvent.dragEnter(window, { dataTransfer: transfer() })
  })
}

describe('NativeSplitDropZones', () => {
  beforeEach(() => vi.clearAllMocks())

  it('stays out of the way until a sidebar row is dragged in', async () => {
    render(<NativeSplitDropZones groupId="g1" editorOwnsCenter={false} />)
    expect(screen.queryByTestId('native-drop-zones')).toBeNull()

    act(() => {
      fireEvent.dragEnter(window, { dataTransfer: transfer(false) })
    })
    expect(screen.queryByTestId('native-drop-zones')).toBeNull()

    startDrag()
    expect(screen.getByTestId('native-drop-zones')).toBeTruthy()

    act(() => {
      fireEvent.dragEnd(window)
    })
    await waitFor(() => {
      expect(screen.queryByTestId('native-drop-zones')).toBeNull()
    })
  })

  it.each([
    ['left', 'horizontal', 'first'],
    ['right', 'horizontal', 'second'],
    ['top', 'vertical', 'first'],
    ['bottom', 'vertical', 'second']
  ])('dropping on the %s edge opens the item in a new split', (zone, direction, position) => {
    const { container } = render(<NativeSplitDropZones groupId="g1" editorOwnsCenter={false} />)
    startDrag()

    fireEvent.drop(container.querySelector(`[data-zone="${zone}"]`)!, {
      dataTransfer: transfer()
    })

    expect(mocks.splitView).toHaveBeenCalledWith(direction, 'g1', {
      cloneActiveTab: false,
      position
    })
    expect(mocks.openTab).toHaveBeenCalledWith(tab, { groupId: 'new-group' })
  })

  it('keeps the zone mounted for its own drop handler when the window sees the drop first', () => {
    const { container } = render(<NativeSplitDropZones groupId="g1" editorOwnsCenter={false} />)
    startDrag()
    const zone = container.querySelector('[data-zone="right"]')!
    // A user-driven drop flushes React between the window capture listener and
    // React's root listener; flushSync inside the listener reproduces that.
    window.addEventListener(
      'drop',
      () => {
        flushSync(() => undefined)
      },
      { capture: true, once: true }
    )

    fireEvent.drop(zone, { dataTransfer: transfer() })

    expect(mocks.openTab).toHaveBeenCalledWith(tab, { groupId: 'new-group' })
  })

  it('opens the item as a tab in the pane when dropped in the centre', () => {
    const { container } = render(<NativeSplitDropZones groupId="g1" editorOwnsCenter={false} />)
    startDrag()

    fireEvent.drop(container.querySelector('[data-zone="center"]')!, { dataTransfer: transfer() })

    expect(mocks.splitView).not.toHaveBeenCalled()
    expect(mocks.openTab).toHaveBeenCalledWith(tab, { groupId: 'g1' })
  })

  it('leaves the centre to the editor when a note is open', () => {
    const { container } = render(<NativeSplitDropZones groupId="g1" editorOwnsCenter />)
    startDrag()
    expect(container.querySelector('[data-zone="center"]')).toBeNull()
    expect(container.querySelector('[data-zone="left"]')).not.toBeNull()
  })
})
