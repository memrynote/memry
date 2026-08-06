import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GraphEvents } from './graph-events'

const mocks = vi.hoisted(() => ({
  events: {} as Record<string, (payload?: any) => void>,
  openTab: vi.fn(),
  viewportToGraph: vi.fn(),
  graph: {
    hasNode: vi.fn(),
    getNodeAttributes: vi.fn()
  }
}))

vi.mock('@react-sigma/core', () => ({
  useRegisterEvents: () => (events: Record<string, (payload?: any) => void>) => {
    mocks.events = events
  },
  useSigma: () => ({
    getGraph: () => mocks.graph,
    viewportToGraph: mocks.viewportToGraph
  })
}))

vi.mock('@/contexts/tabs', () => ({
  useTabActions: () => ({ openTab: mocks.openTab })
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => (key === 'context-menu.untitled' ? 'Untitled' : key) })
}))

describe('GraphEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.events = {}
    document.body.style.cursor = ''
  })

  it('registers hover, click, context menu, and stage handlers', () => {
    const onHoverNode = vi.fn()
    const onTooltipMove = vi.fn()
    const onFocusNode = vi.fn()
    const onContextMenu = vi.fn()
    mocks.graph.hasNode.mockReturnValue(true)
    mocks.graph.getNodeAttributes.mockReturnValue({
      nodeType: 'note',
      label: 'Roadmap',
      isUnresolved: false
    })

    render(
      <GraphEvents
        onHoverNode={onHoverNode}
        onTooltipMove={onTooltipMove}
        onFocusNode={onFocusNode}
        onContextMenu={onContextMenu}
      />
    )

    mocks.events.enterNode({ node: 'note-1', event: { x: 10, y: 20 } })
    expect(onHoverNode).toHaveBeenCalledWith('note-1')
    expect(onTooltipMove).toHaveBeenCalledWith({ x: 10, y: 20 })
    expect(document.body.style.cursor).toBe('pointer')

    mocks.events.leaveNode()
    expect(onHoverNode).toHaveBeenCalledWith(null)
    expect(onTooltipMove).toHaveBeenCalledWith(null)
    expect(document.body.style.cursor).toBe('default')

    mocks.events.clickNode({ node: 'note-1' })
    expect(onContextMenu).toHaveBeenCalledWith(null)
    expect(mocks.openTab).toHaveBeenCalledWith({
      type: 'note',
      title: 'Roadmap',
      icon: 'file-text',
      path: '/note/note-1',
      entityId: 'note-1',
      isPinned: false,
      isModified: false,
      isPreview: false,
      isDeleted: false
    })

    const preventSigmaDefault = vi.fn()
    mocks.events.rightClickNode({ node: 'note-1', event: { x: 1, y: 2, preventSigmaDefault } })
    expect(preventSigmaDefault).toHaveBeenCalled()
    expect(onContextMenu).toHaveBeenCalledWith({ nodeId: 'note-1', x: 1, y: 2 })

    mocks.events.clickStage()
    expect(onContextMenu).toHaveBeenLastCalledWith(null)
  })

  it('ignores missing, unresolved, and unsupported graph nodes', () => {
    render(
      <GraphEvents
        onHoverNode={vi.fn()}
        onTooltipMove={vi.fn()}
        onFocusNode={vi.fn()}
        onContextMenu={vi.fn()}
      />
    )

    mocks.graph.hasNode.mockReturnValue(false)
    mocks.events.clickNode({ node: 'missing' })
    expect(mocks.openTab).not.toHaveBeenCalled()

    mocks.graph.hasNode.mockReturnValue(true)
    mocks.graph.getNodeAttributes.mockReturnValue({ nodeType: 'note', isUnresolved: true })
    mocks.events.clickNode({ node: 'ghost' })
    expect(mocks.openTab).not.toHaveBeenCalled()

    mocks.graph.getNodeAttributes.mockReturnValue({ nodeType: 'unknown', isUnresolved: false })
    mocks.events.clickNode({ node: 'other' })
    expect(mocks.openTab).not.toHaveBeenCalled()

    mocks.graph.getNodeAttributes.mockReturnValue({ nodeType: 'task', isUnresolved: false })
    mocks.events.clickNode({ node: 'task-1' })
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tasks',
        title: 'Untitled',
        icon: 'list-checks',
        path: '/task/task-1'
      })
    )
  })

  describe('node dragging', () => {
    function renderWithDrag(): {
      onNodeGrab: ReturnType<typeof vi.fn>
      onNodeDrag: ReturnType<typeof vi.fn>
      onNodeRelease: ReturnType<typeof vi.fn>
    } {
      const handlers = {
        onNodeGrab: vi.fn(),
        onNodeDrag: vi.fn(),
        onNodeRelease: vi.fn()
      }
      render(
        <GraphEvents
          onHoverNode={vi.fn()}
          onTooltipMove={vi.fn()}
          onFocusNode={vi.fn()}
          onContextMenu={vi.fn()}
          {...handlers}
        />
      )
      return handlers
    }

    it('grabs a node on pointer down', () => {
      const { onNodeGrab } = renderWithDrag()

      mocks.events.downNode({ node: 'note-1', event: { x: 5, y: 5 } })

      expect(onNodeGrab).toHaveBeenCalledWith('note-1')
      expect(document.body.style.cursor).toBe('grabbing')
    })

    it('drags the grabbed node in graph coordinates and blocks the camera pan', () => {
      const { onNodeDrag } = renderWithDrag()
      mocks.viewportToGraph.mockReturnValue({ x: 120, y: -40 })
      const preventSigmaDefault = vi.fn()

      mocks.events.downNode({ node: 'note-1', event: { x: 5, y: 5 } })
      mocks.events.mousemovebody({ x: 60, y: 80, preventSigmaDefault })

      expect(mocks.viewportToGraph).toHaveBeenCalledWith({ x: 60, y: 80 })
      expect(onNodeDrag).toHaveBeenCalledWith('note-1', 120, -40)
      expect(preventSigmaDefault).toHaveBeenCalled()
    })

    it('leaves the camera alone when no node is grabbed', () => {
      const { onNodeDrag } = renderWithDrag()
      const preventSigmaDefault = vi.fn()

      mocks.events.mousemovebody({ x: 60, y: 80, preventSigmaDefault })

      expect(onNodeDrag).not.toHaveBeenCalled()
      expect(preventSigmaDefault).not.toHaveBeenCalled()
    })

    it('releases the node on mouse up', () => {
      const { onNodeRelease } = renderWithDrag()

      mocks.events.downNode({ node: 'note-1', event: { x: 5, y: 5 } })
      mocks.events.mouseup()

      expect(onNodeRelease).toHaveBeenCalledWith('note-1')
    })

    it('does not open a tab when the pointer actually dragged the node', () => {
      renderWithDrag()
      mocks.viewportToGraph.mockReturnValue({ x: 200, y: 200 })
      mocks.graph.hasNode.mockReturnValue(true)
      mocks.graph.getNodeAttributes.mockReturnValue({
        nodeType: 'note',
        label: 'Roadmap',
        isUnresolved: false
      })

      mocks.events.downNode({ node: 'note-1', event: { x: 5, y: 5 } })
      mocks.events.mousemovebody({ x: 90, y: 90, preventSigmaDefault: vi.fn() })
      mocks.events.mouseup()
      mocks.events.clickNode({ node: 'note-1' })

      expect(mocks.openTab).not.toHaveBeenCalled()
    })

    it('still opens a tab when the node was pressed without moving', () => {
      renderWithDrag()
      mocks.graph.hasNode.mockReturnValue(true)
      mocks.graph.getNodeAttributes.mockReturnValue({
        nodeType: 'note',
        label: 'Roadmap',
        isUnresolved: false
      })

      mocks.events.downNode({ node: 'note-1', event: { x: 5, y: 5 } })
      mocks.events.mouseup()
      mocks.events.clickNode({ node: 'note-1' })

      expect(mocks.openTab).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'note-1' }))
    })

    it('treats sub-threshold jitter as a click, not a drag', () => {
      renderWithDrag()
      mocks.viewportToGraph.mockReturnValue({ x: 1, y: 1 })
      mocks.graph.hasNode.mockReturnValue(true)
      mocks.graph.getNodeAttributes.mockReturnValue({
        nodeType: 'note',
        label: 'Roadmap',
        isUnresolved: false
      })

      mocks.events.downNode({ node: 'note-1', event: { x: 5, y: 5 } })
      mocks.events.mousemovebody({ x: 6, y: 6, preventSigmaDefault: vi.fn() })
      mocks.events.mouseup()
      mocks.events.clickNode({ node: 'note-1' })

      expect(mocks.openTab).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'note-1' }))
    })
  })
})
