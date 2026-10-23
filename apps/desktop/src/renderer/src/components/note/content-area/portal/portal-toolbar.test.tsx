import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PortalToolbar, type PortalToolbarProps } from './portal-toolbar'

function renderToolbar(over: Partial<PortalToolbarProps> = {}): PortalToolbarProps {
  const props: PortalToolbarProps = {
    title: 'Source note',
    ancestors: [],
    hiddenSiblingCount: 0,
    locked: false,
    compact: false,
    editable: true,
    onIncludeParent: vi.fn(),
    onOpenHidden: vi.fn(),
    onOpenSource: vi.fn(),
    onOpenSourceInNewTab: vi.fn(),
    onOpenBeside: vi.fn(),
    onCopyContents: vi.fn(),
    onCopyLink: vi.fn(),
    onRemove: vi.fn(),
    onMenuOpenChange: vi.fn(),
    ...over
  }
  render(<PortalToolbar {...props} />)
  return props
}

describe('PortalToolbar source title', () => {
  it('opens the source in a new tab on middle click only', () => {
    const props = renderToolbar()
    const title = screen.getByText('Source note')
    fireEvent(title, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 }))
    expect(props.onOpenSourceInNewTab).not.toHaveBeenCalled()
    fireEvent(title, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))
    expect(props.onOpenSourceInNewTab).toHaveBeenCalledTimes(1)
    expect(props.onOpenSource).not.toHaveBeenCalled()
  })
})
