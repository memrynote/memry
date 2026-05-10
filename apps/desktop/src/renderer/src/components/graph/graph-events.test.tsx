import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GraphEvents } from './graph-events'

const mocks = vi.hoisted(() => ({
  events: {} as Record<string, (payload?: any) => void>,
  openTab: vi.fn(),
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
    getGraph: () => mocks.graph
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
      isPreview: true,
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
})
