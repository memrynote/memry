import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SplitLayout } from '@/contexts/tabs/types'
import { SplitLayoutRenderer } from './split-layout-renderer'

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({
    dispatch: vi.fn(),
    state: { activeGroupId: 'a', tabGroups: { a: {}, b: {}, c: {} } }
  })
}))

vi.mock('./split-pane', () => ({
  SplitPane: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('./tab-pane-with-drop-zones', () => ({
  TabPaneWithDropZones: ({
    groupId,
    inTitleRow,
    reserveWindowControls
  }: {
    groupId: string
    inTitleRow?: boolean
    reserveWindowControls?: boolean
  }) => (
    <div
      data-testid={`pane-${groupId}`}
      data-title-row={String(inTitleRow)}
      data-reserve={String(reserveWindowControls)}
    />
  )
}))

const leaf = (tabGroupId: string): SplitLayout => ({ type: 'leaf', tabGroupId })

describe('SplitLayoutRenderer title row', () => {
  it('keeps both side-by-side panes in the title row', () => {
    render(
      <SplitLayoutRenderer
        layout={{
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: leaf('a'),
          second: leaf('b')
        }}
        path={[]}
      />
    )
    expect(screen.getByTestId('pane-a')).toHaveAttribute('data-title-row', 'true')
    expect(screen.getByTestId('pane-b')).toHaveAttribute('data-title-row', 'true')
    // Only the top-start pane reserves room for the window controls.
    expect(screen.getByTestId('pane-a')).toHaveAttribute('data-reserve', 'true')
    expect(screen.getByTestId('pane-b')).toHaveAttribute('data-reserve', 'false')
  })

  it('keeps the lower pane of a stacked split out of the title row', () => {
    render(
      <SplitLayoutRenderer
        layout={{
          type: 'split',
          direction: 'vertical',
          ratio: 0.5,
          first: {
            type: 'split',
            direction: 'horizontal',
            ratio: 0.5,
            first: leaf('a'),
            second: leaf('b')
          },
          second: leaf('c')
        }}
        path={[]}
      />
    )
    expect(screen.getByTestId('pane-a')).toHaveAttribute('data-title-row', 'true')
    expect(screen.getByTestId('pane-b')).toHaveAttribute('data-title-row', 'true')
    expect(screen.getByTestId('pane-c')).toHaveAttribute('data-title-row', 'false')
  })
})
