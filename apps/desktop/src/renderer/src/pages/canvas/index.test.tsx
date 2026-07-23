import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CanvasPage } from './index'
import type { Canvas } from '@/services/canvas-service'

// The real editor cannot mount here (Excalidraw needs layout/canvas, jsdom has
// neither — E2E covers it), so the lazy './canvas-editor' import is stubbed
// with a component that mimics Excalidraw's one load-bearing behaviour:
// initialData/initialScene is consumed ONLY at mount. The stub captures the
// scene in one-shot state, so it can only show a later scene by remounting —
// which is exactly what the key={canvas.id} regression tests assert.
const mocks = vi.hoisted(() => ({
  flags: { spatialCanvas: false },
  flagsLoading: false,
  get: vi.fn<(id: string) => Promise<Canvas | null>>()
}))

vi.mock('./canvas-editor', async () => {
  const React = await import('react')
  return {
    CanvasEditor: ({
      canvasId,
      initialScene
    }: {
      canvasId: string
      initialScene: string
    }): React.JSX.Element => {
      const [mountScene] = React.useState(initialScene)
      return <div data-testid="editor-stub" data-canvas-id={canvasId} data-scene={mountScene} />
    }
  }
})

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) ?? key })
}))

vi.mock('@/hooks/use-feature-flags', () => ({
  useFeatureFlags: () => ({
    flags: mocks.flags,
    isLoading: mocks.flagsLoading,
    error: null,
    isEnabled: (key: string) => mocks.flags[key as 'spatialCanvas'],
    setFlag: vi.fn()
  })
}))

vi.mock('@/services/canvas-service', () => ({
  canvasService: { get: (id: string) => mocks.get(id) }
}))

const makeCanvas = (id: string, scene: string): Canvas => ({
  id,
  title: id,
  scene,
  createdAt: 1,
  updatedAt: 1
})

describe('CanvasPage', () => {
  beforeEach(() => {
    mocks.flags = { spatialCanvas: false }
    mocks.flagsLoading = false
    mocks.get.mockReset()
  })

  it('renders the flag-off placeholder without fetching (restored hidden-phase tabs)', () => {
    const { container } = render(<CanvasPage canvasId="c1" />)

    expect(container.querySelector('[data-canvas-placeholder]')).not.toBeNull()
    expect(screen.getByText('disabledTitle')).toBeInTheDocument()
    expect(mocks.get).not.toHaveBeenCalled()
  })

  it('renders nothing identifiable while flags are still loading', () => {
    mocks.flagsLoading = true
    const { container } = render(<CanvasPage canvasId="c1" />)

    expect(container.querySelector('[data-canvas-placeholder]')).toBeNull()
    expect(screen.queryByText('disabledTitle')).not.toBeInTheDocument()
  })

  it('shows not-found when the canvas id is missing', () => {
    mocks.flags = { spatialCanvas: true }
    render(<CanvasPage />)

    expect(screen.getByText('notFound')).toBeInTheDocument()
    expect(mocks.get).not.toHaveBeenCalled()
  })

  it('shows not-found when the canvas does not exist', async () => {
    mocks.flags = { spatialCanvas: true }
    mocks.get.mockResolvedValue(null)

    render(<CanvasPage canvasId="gone" />)
    await waitFor(() => {
      expect(screen.getByText('notFound')).toBeInTheDocument()
    })
    expect(mocks.get).toHaveBeenCalledWith('gone')
  })

  it('shows the load error when fetching fails', async () => {
    mocks.flags = { spatialCanvas: true }
    mocks.get.mockRejectedValue(new Error('vault locked'))

    render(<CanvasPage canvasId="c1" />)
    await waitFor(() => {
      expect(screen.getByText('vault locked')).toBeInTheDocument()
    })
  })

  it('mounts the editor with the fetched scene', async () => {
    mocks.flags = { spatialCanvas: true }
    mocks.get.mockResolvedValue(makeCanvas('c1', 'scene-1'))

    render(<CanvasPage canvasId="c1" />)

    const editor = await screen.findByTestId('editor-stub')
    expect(editor).toHaveAttribute('data-canvas-id', 'c1')
    expect(editor).toHaveAttribute('data-scene', 'scene-1')
  })

  it('remounts the editor with the new scene when canvasId changes (stale-scene regression)', async () => {
    mocks.flags = { spatialCanvas: true }
    mocks.get.mockImplementation(async (id) => makeCanvas(id, `scene-${id}`))

    const { rerender } = render(<CanvasPage canvasId="istanbul" />)
    const editor = await screen.findByTestId('editor-stub')
    expect(editor).toHaveAttribute('data-scene', 'scene-istanbul')

    rerender(<CanvasPage canvasId="launch" />)

    // The stub only ever shows the scene it MOUNTED with (Excalidraw
    // semantics); seeing the new scene proves the key remounted the editor
    // instead of leaving the old canvas on screen — and, worse, letting its
    // persister save the old scene under the new canvas id.
    await waitFor(() => {
      expect(screen.getByTestId('editor-stub')).toHaveAttribute('data-scene', 'scene-launch')
    })
    expect(screen.getByTestId('editor-stub')).toHaveAttribute('data-canvas-id', 'launch')
  })
})
