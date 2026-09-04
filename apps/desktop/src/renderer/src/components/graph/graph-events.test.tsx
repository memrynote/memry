import { useRef, type ReactElement } from 'react'
import { render } from '@testing-library/react'
import Graph from 'graphology'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GraphEvents } from './graph-events'
import { LivePhysics, type PhysicsHandle } from './physics-layout'

const mocks = vi.hoisted(() => ({
  events: {} as Record<string, (payload?: any) => void>,
  openTab: vi.fn(),
  viewportToGraph: vi.fn(),
  refresh: vi.fn(),
  graph: {
    hasNode: vi.fn(),
    getNodeAttributes: vi.fn()
  },
  // Set by the physics tests so `useSigma().getGraph()` hands back the real
  // graphology instance LivePhysics compares against.
  liveGraph: null as Graph | null
}))

vi.mock('@react-sigma/core', () => ({
  useRegisterEvents: () => (events: Record<string, (payload?: any) => void>) => {
    mocks.events = events
  },
  useSigma: () => ({
    getGraph: () => mocks.liveGraph ?? mocks.graph,
    // jsdom does no layout, so a real element measures 0 and the refresh guard
    // would skip every repaint. Hand it one that measures.
    getContainer: (): HTMLElement =>
      Object.defineProperty(document.createElement('div'), 'offsetWidth', { value: 800 }),
    viewportToGraph: mocks.viewportToGraph,
    refresh: mocks.refresh
  })
}))

vi.mock('@/contexts/tabs', () => ({
  useTabActions: () => ({ openTab: mocks.openTab })
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => (key === 'context-menu.untitled' ? 'Untitled' : key) })
}))

/** GraphEvents wired to a real simulation, the way graph-canvas wires them. */
function DragHarness({ graph }: { graph: Graph }): ReactElement {
  const handleRef = useRef<PhysicsHandle | null>(null)
  return (
    <>
      <LivePhysics graph={graph} handleRef={handleRef} />
      <GraphEvents
        onHoverNode={vi.fn()}
        onTooltipMove={vi.fn()}
        onFocusNode={vi.fn()}
        onContextMenu={vi.fn()}
        onNodeGrab={(nodeId) => handleRef.current?.grab(nodeId)}
        onNodeDrag={(nodeId, x, y) => handleRef.current?.drag(nodeId, x, y)}
        onNodeRelease={(nodeId) => handleRef.current?.release(nodeId)}
      />
    </>
  )
}

describe('GraphEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.events = {}
    mocks.liveGraph = null
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

    it('releases the node when the pointer comes up outside the window', () => {
      const { onNodeDrag, onNodeRelease } = renderWithDrag()

      mocks.events.downNode({ node: 'note-1', event: { x: 5, y: 5 } })
      // Sigma binds mouseup on `document`; a release the window never sees only
      // reaches us as a window-level pointerup.
      window.dispatchEvent(new Event('pointerup'))

      expect(onNodeRelease).toHaveBeenCalledWith('note-1')
      expect(document.body.style.cursor).toBe('pointer')

      // The drag is over: a later pointer move must not keep hauling the node.
      mocks.events.mousemovebody({ x: 200, y: 200, preventSigmaDefault: vi.fn() })
      expect(onNodeDrag).not.toHaveBeenCalled()
    })

    it('releases the node when the window loses focus mid-drag', () => {
      const { onNodeRelease } = renderWithDrag()

      mocks.events.downNode({ node: 'note-1', event: { x: 5, y: 5 } })
      window.dispatchEvent(new Event('blur'))

      expect(onNodeRelease).toHaveBeenCalledWith('note-1')
    })

    it('releases the node when another element swallows the pointerup', () => {
      const { onNodeRelease } = renderWithDrag()
      const overlay = document.createElement('div')
      document.body.appendChild(overlay)
      overlay.addEventListener('pointerup', (event) => event.stopPropagation())

      try {
        mocks.events.downNode({ node: 'note-1', event: { x: 5, y: 5 } })
        overlay.dispatchEvent(new Event('pointerup', { bubbles: true }))

        expect(onNodeRelease).toHaveBeenCalledWith('note-1')
      } finally {
        overlay.remove()
      }
    })

    it('releases the node when the browser cancels the pointer', () => {
      const { onNodeRelease } = renderWithDrag()

      mocks.events.downNode({ node: 'note-1', event: { x: 5, y: 5 } })
      window.dispatchEvent(new Event('pointercancel'))

      expect(onNodeRelease).toHaveBeenCalledWith('note-1')
    })

    it('releases only once when both pointerup and mouseup arrive', () => {
      const { onNodeRelease } = renderWithDrag()

      mocks.events.downNode({ node: 'note-1', event: { x: 5, y: 5 } })
      window.dispatchEvent(new Event('pointerup'))
      mocks.events.mouseup()

      expect(onNodeRelease).toHaveBeenCalledTimes(1)
    })

    it('still suppresses the click that follows an interrupted drag', () => {
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
      window.dispatchEvent(new Event('pointerup'))
      mocks.events.mouseup()
      mocks.events.clickNode({ node: 'note-1' })

      expect(mocks.openTab).not.toHaveBeenCalled()
    })

    it('removes its window listeners on unmount', () => {
      const addSpy = vi.spyOn(window, 'addEventListener')
      const removeSpy = vi.spyOn(window, 'removeEventListener')

      const { unmount } = render(
        <GraphEvents
          onHoverNode={vi.fn()}
          onTooltipMove={vi.fn()}
          onFocusNode={vi.fn()}
          onContextMenu={vi.fn()}
          onNodeGrab={vi.fn()}
          onNodeDrag={vi.fn()}
          onNodeRelease={vi.fn()}
        />
      )

      const added = addSpy.mock.calls.filter(([type]) =>
        ['pointerup', 'pointercancel', 'blur'].includes(type)
      )
      expect(added.length).toBeGreaterThan(0)

      unmount()

      for (const [type, handler, options] of added) {
        expect(removeSpy).toHaveBeenCalledWith(type, handler, options)
      }
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

  describe('live physics frame loop', () => {
    let pending: Map<number, FrameRequestCallback>
    let raf: ReturnType<typeof vi.fn>

    beforeEach(() => {
      pending = new Map()
      let nextFrameId = 1
      raf = vi.fn((callback: FrameRequestCallback) => {
        const id = nextFrameId++
        pending.set(id, callback)
        return id
      })
      vi.stubGlobal('requestAnimationFrame', raf)
      vi.stubGlobal('cancelAnimationFrame', (id: number) => pending.delete(id))
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    /** Run queued frames until the loop parks. `true` means it stopped on its own. */
    function drainFrames(limit: number): boolean {
      for (let i = 0; i < limit; i++) {
        if (pending.size === 0) return true
        const due = [...pending.values()]
        pending.clear()
        for (const callback of due) callback(i)
      }
      return pending.size === 0
    }

    function stepFrames(count: number): void {
      for (let i = 0; i < count; i++) {
        const due = [...pending.values()]
        pending.clear()
        for (const callback of due) callback(i)
      }
    }

    function renderLiveGraph(): Graph {
      const graph = new Graph({ type: 'undirected' })
      graph.addNode('a', { x: 0, y: 0, size: 5 })
      graph.addNode('b', { x: 40, y: 0, size: 5 })
      graph.addNode('c', { x: 0, y: 40, size: 5 })
      graph.addEdgeWithKey('e0', 'a', 'b', { weight: 1 })
      mocks.liveGraph = graph
      render(<DragHarness graph={graph} />)
      return graph
    }

    function startDrag(nodeId: string, x: number, y: number): void {
      mocks.viewportToGraph.mockReturnValue({ x, y })
      mocks.events.downNode({ node: nodeId, event: { x: 5, y: 5 } })
      mocks.events.mousemovebody({ x: 90, y: 90, preventSigmaDefault: vi.fn() })
    }

    it('parks the frame loop when the pointer is released outside the window', () => {
      renderLiveGraph()
      expect(drainFrames(2000)).toBe(true)

      startDrag('a', 300, 300)
      // Held: the simulation is deliberately kept warm while a node is dragged.
      expect(drainFrames(600)).toBe(false)

      window.dispatchEvent(new Event('pointerup'))

      expect(drainFrames(2000)).toBe(true)
      const scheduled = raf.mock.calls.length
      stepFrames(10)
      expect(raf.mock.calls.length).toBe(scheduled)
      expect(pending.size).toBe(0)
    })

    it('parks the frame loop when the window loses focus mid-drag', () => {
      renderLiveGraph()
      expect(drainFrames(2000)).toBe(true)

      startDrag('a', 300, 300)
      expect(drainFrames(600)).toBe(false)

      window.dispatchEvent(new Event('blur'))

      expect(drainFrames(2000)).toBe(true)
    })

    it('keeps dragging normally after a drag that ended outside the window', () => {
      const graph = renderLiveGraph()
      expect(drainFrames(2000)).toBe(true)

      startDrag('a', 300, 300)
      window.dispatchEvent(new Event('pointerup'))
      expect(drainFrames(2000)).toBe(true)

      startDrag('b', -150, 220)
      stepFrames(3)
      expect(graph.getNodeAttribute('b', 'x')).toBe(-150)
      expect(graph.getNodeAttribute('b', 'y')).toBe(220)
      expect(drainFrames(600)).toBe(false)

      mocks.events.mouseup()

      expect(drainFrames(2000)).toBe(true)
      expect(graph.getNodeAttribute('b', 'x')).not.toBe(-150)
    })
  })
})
