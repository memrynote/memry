import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePdfDisplayMenu } from './use-pdf-display-menu'

function setup(defaultDisplay?: 'embed' | 'link') {
  const container = document.createElement('div')
  const blockEl = document.createElement('div')
  blockEl.setAttribute('data-id', 'pdf-1')
  container.append(blockEl)
  document.body.append(container)
  const editor = {
    getBlock: vi.fn(() => ({ props: { url: 'a.pdf', display: undefined } })),
    updateBlock: vi.fn()
  }
  const hook = renderHook(() =>
    usePdfDisplayMenu({ editor, editorContainerRef: { current: container }, defaultDisplay })
  )
  return { ...hook, editor, container }
}

const openMenu = async (result: ReturnType<typeof setup>['result']) => {
  await act(async () => {
    result.current.open('pdf-1')
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  })
}

describe('usePdfDisplayMenu', () => {
  beforeEach(() => {
    vi.stubGlobal('CSS', { escape: (v: string) => v })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('opens on the Settings default and writes the picked mode to the block', async () => {
    const { result, editor } = setup('link')
    await openMenu(result)
    expect(result.current.state?.selectedIndex).toBe(1)

    act(() => result.current.select('embed'))
    expect(editor.updateBlock).toHaveBeenCalledWith('pdf-1', {
      props: { url: 'a.pdf', display: 'embed' }
    })
    expect(result.current.state).toBeNull()
  })

  it('arrows move, Enter picks', async () => {
    const { result, editor, container } = setup('embed')
    await openMenu(result)

    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(editor.updateBlock).toHaveBeenCalledWith('pdf-1', {
      props: { url: 'a.pdf', display: 'link' }
    })
  })

  it('Escape and click-away keep the inserted default', async () => {
    const { result, editor, container } = setup('embed')
    await openMenu(result)
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(result.current.state).toBeNull()

    await openMenu(result)
    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(result.current.state).toBeNull()
    expect(editor.updateBlock).not.toHaveBeenCalled()
  })
})
