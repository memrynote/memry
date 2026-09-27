import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useIsItemActive } from './use-is-item-active'

const tabs = vi.hoisted(() => ({
  state: {} as {
    activeGroupId: string
    tabGroups: Record<string, { tabs: { id: string; type: string }[]; activeTabId: string }>
  }
}))

vi.mock('@/contexts/tabs', () => ({ useTabs: () => ({ state: tabs.state }) }))

function setActive(type: string): void {
  tabs.state = {
    activeGroupId: 'g',
    tabGroups: { g: { tabs: [{ id: type, type }], activeTabId: type } }
  }
}

// Reads isActiveItem while rendering, the way the app rail does.
function Probe(): React.JSX.Element {
  const isActive = useIsItemActive()
  return (
    <span>{isActive({ type: 'journal', title: 'Journal', path: '/journal' }) ? 'on' : 'off'}</span>
  )
}

describe('useIsItemActive', () => {
  it('reflects a tab switch on the same render, not one render later', () => {
    setActive('inbox')
    const { container, rerender } = render(<Probe />)
    expect(container).toHaveTextContent('off')

    setActive('journal')
    rerender(<Probe />)
    expect(container).toHaveTextContent('on')
  })
})
