import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CanvasPage } from './index'
import type { Canvas } from '@/services/canvas-service'

// The editor success path is deliberately untested here: mounting it lazy-loads
// Excalidraw, which jsdom cannot host (no layout, no canvas). E2E covers it.
const mocks = vi.hoisted(() => ({
  flags: { spatialCanvas: false },
  flagsLoading: false,
  get: vi.fn<(id: string) => Promise<Canvas | null>>()
}))

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
})
