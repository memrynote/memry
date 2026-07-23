/**
 * TabContent canvas keying — regression test for the stale-canvas bug.
 *
 * TabPane renders ONE TabContent for the active tab (no key), so switching
 * between two canvas tabs re-renders the same element tree. Excalidraw only
 * consumes its scene at mount, so the canvas case must key the page by entity
 * id to force a remount; without it the previous canvas stays on screen and
 * its persister saves that scene under the new canvas id.
 */

import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TabContent } from './tab-content'
import type { Tab } from '@/contexts/tabs/types'

const mocks = vi.hoisted(() => ({
  canvasMounts: [] as string[]
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('@/contexts/tabs', () => ({
  useTabActions: () => ({ dispatch: vi.fn() })
}))

vi.mock('@/contexts/tasks', () => ({
  useTasksOptional: () => null
}))

// Top-level (non-lazy) import in tab-content; stub so its page graph stays out.
vi.mock('@/pages/inbox', () => ({
  InboxPage: () => <div />
}))

vi.mock('@/pages/canvas', async () => {
  const React = await import('react')
  return {
    CanvasPage: ({ canvasId }: { canvasId?: string }): React.JSX.Element => {
      // One push per MOUNT (not per render): remount detection is the test.
      React.useEffect(() => {
        mocks.canvasMounts.push(canvasId ?? '')
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])
      return <div data-testid="canvas-page-stub" data-canvas-id={canvasId} />
    }
  }
})

const makeCanvasTab = (id: string, entityId: string): Tab => ({
  id,
  type: 'canvas',
  title: entityId,
  icon: 'pen-tool',
  path: `/canvas/${entityId}`,
  entityId,
  isPinned: false,
  isModified: false,
  isPreview: false,
  isDeleted: false,
  openedAt: 1,
  lastAccessedAt: 1
})

describe('TabContent canvas tabs', () => {
  beforeEach(() => {
    mocks.canvasMounts = []
  })

  it('remounts the canvas page when the active canvas tab changes', async () => {
    const { rerender } = render(
      <TabContent tab={makeCanvasTab('tab-1', 'istanbul')} groupId="main" />
    )
    await waitFor(() => {
      expect(screen.getByTestId('canvas-page-stub')).toHaveAttribute('data-canvas-id', 'istanbul')
    })
    expect(mocks.canvasMounts).toEqual(['istanbul'])

    rerender(<TabContent tab={makeCanvasTab('tab-2', 'launch')} groupId="main" />)

    await waitFor(() => {
      expect(screen.getByTestId('canvas-page-stub')).toHaveAttribute('data-canvas-id', 'launch')
    })
    // A second MOUNT proves the key swapped the component instance; prop-only
    // reuse would leave one mount and (in the real page) the old scene.
    expect(mocks.canvasMounts).toEqual(['istanbul', 'launch'])
  })
})
