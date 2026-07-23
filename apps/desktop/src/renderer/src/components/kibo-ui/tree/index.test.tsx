import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forwardRef } from 'react'

import {
  TreeExpander,
  TreeIcon,
  TreeNode,
  TreeNodeContent,
  TreeNodeTrigger,
  TreeProvider,
  TreeView,
  useTree
} from './index'
import { CANVAS_ITEM_DRAG_MIME } from '@/pages/canvas/canvas-cards'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) ?? key })
}))

vi.mock('motion/react', () => {
  const Div = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({ children, ...props }, ref) => {
      const {
        whileHover: _whileHover,
        transition: _transition,
        animate: _animate,
        exit: _exit,
        initial: _initial,
        ...domProps
      } = props as React.HTMLAttributes<HTMLDivElement> & Record<string, unknown>
      return (
        <div ref={ref} {...domProps}>
          {children}
        </div>
      )
    }
  )
  Div.displayName = 'MotionDiv'

  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    LazyMotion: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    domAnimation: {},
    m: { div: Div }
  }
})

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({
    children,
    onClick
  }: {
    children: React.ReactNode
    onClick?: (event: React.MouseEvent) => void
  }) => (
    <button type="button" onClick={(event) => onClick?.(event)}>
      {children}
    </button>
  ),
  ContextMenuSeparator: () => <hr />
}))

vi.mock('@/components/icon-picker', () => ({
  getIconByName: (name: string) =>
    name === 'Missing' ? null : (props: { className?: string }) => <span {...props}>icon</span>,
  IconPicker: ({
    isOpen,
    onClose,
    onSelect,
    currentIcon
  }: {
    isOpen: boolean
    onClose: () => void
    onSelect: (iconName: string) => void
    currentIcon?: string
  }) =>
    isOpen ? (
      <div role="listbox" aria-label={`icon-picker-${currentIcon ?? 'none'}`}>
        <button type="button" onClick={() => onSelect('Star')}>
          choose Star
        </button>
        <button type="button" onClick={onClose}>
          close picker
        </button>
      </div>
    ) : null
}))

function Controls() {
  const tree = useTree()
  return (
    <div>
      <span data-testid="selected">{tree.selectedIds.join(',')}</span>
      <span data-testid="focused">{tree.focusedId ?? 'none'}</span>
      <span data-testid="root-icon">{tree.getEffectiveIcon('root') ?? 'none'}</span>
      <button type="button" onClick={() => tree.expandAll()}>
        expand all
      </button>
      <button type="button" onClick={() => tree.collapseAll()}>
        collapse all
      </button>
      <button type="button" onClick={() => tree.expandNodes(['root'])}>
        expand root
      </button>
      <button type="button" onClick={() => tree.setNodeIcon('missing', 'Star')}>
        set missing
      </button>
    </div>
  )
}

function renderTree(
  props: Partial<React.ComponentProps<typeof TreeProvider>> = {},
  rootProps: Partial<React.ComponentProps<typeof TreeNodeTrigger>> = {}
) {
  const onSelectionChange = vi.fn()
  const onMove = vi.fn()
  const onIconChange = vi.fn()

  render(
    <TreeProvider
      defaultExpandedIds={['root']}
      persistKey="tree-test"
      multiSelect
      draggable
      onSelectionChange={onSelectionChange}
      onMove={onMove}
      onIconChange={onIconChange}
      {...props}
    >
      <Controls />
      <TreeView>
        <TreeNode nodeId="root" hasChildren customIcon="Folder">
          <TreeNodeTrigger {...rootProps}>
            <TreeExpander />
            <TreeIcon hasChildren />
            <span>Root</span>
          </TreeNodeTrigger>
          <TreeNodeContent>
            <TreeNode nodeId="child-a" level={1} hasChildren acceptsDropInside>
              <TreeNodeTrigger>
                <TreeExpander />
                <TreeIcon hasChildren iconName="Missing" />
                <span>Child A</span>
              </TreeNodeTrigger>
              <TreeNodeContent>
                <TreeNode nodeId="grandchild" level={2} isLast>
                  <TreeNodeTrigger showIconMenu={false}>
                    <TreeIcon />
                    <span>Grandchild</span>
                  </TreeNodeTrigger>
                </TreeNode>
              </TreeNodeContent>
            </TreeNode>
            <TreeNode nodeId="child-b" level={1} isLast>
              <TreeNodeTrigger contextMenuContent={<button type="button">custom menu</button>}>
                <TreeIcon icon={<span>custom icon</span>} />
                <span>Child B</span>
              </TreeNodeTrigger>
            </TreeNode>
          </TreeNodeContent>
        </TreeNode>
      </TreeView>
    </TreeProvider>
  )

  return { onSelectionChange, onMove, onIconChange }
}

function dataTransfer() {
  return {
    effectAllowed: '',
    dropEffect: '',
    setData: vi.fn()
  }
}

describe('TreeProvider and tree primitives', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('selects, multi-selects, expands, collapses, and persists expanded ids', () => {
    const { onSelectionChange } = renderTree()

    fireEvent.click(screen.getByText('Root'))
    expect(onSelectionChange).toHaveBeenCalledWith(['root'])
    expect(screen.getByTestId('focused')).toHaveTextContent('root')
    expect(screen.queryByText('Child A')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'expand root' }))
    expect(screen.getByText('Child A')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Child A'), { metaKey: true })
    expect(onSelectionChange).toHaveBeenLastCalledWith(['root', 'child-a'])

    fireEvent.click(screen.getByText('Child B'), { shiftKey: true })
    expect(onSelectionChange).toHaveBeenLastCalledWith(['child-a', 'grandchild', 'child-b'])

    fireEvent.click(screen.getByRole('button', { name: 'collapse all' }))
    expect(screen.queryByText('Child A')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'expand all' }))
    fireEvent.click(screen.getByText('Child A'))
    expect(screen.getByText('Grandchild')).toBeInTheDocument()

    vi.advanceTimersByTime(500)
    expect(localStorage.getItem('tree-test')).toContain('root')
  })

  it('handles keyboard navigation, drag/drop, icon menu, and icon inheritance', () => {
    const { onMove, onIconChange } = renderTree()

    const root = screen.getByText('Root').closest('[data-tree-node-id]') as HTMLElement
    const childA = screen.getByText('Child A').closest('[data-tree-node-id]') as HTMLElement
    const childB = screen.getByText('Child B').closest('[data-tree-node-id]') as HTMLElement

    root.focus()
    fireEvent.keyDown(root, { key: 'ArrowDown' })
    expect(screen.getByTestId('selected')).toHaveTextContent('child-a')

    fireEvent.keyDown(childA, { key: 'ArrowRight' })
    expect(screen.getByText('Grandchild')).toBeInTheDocument()

    fireEvent.keyDown(childA, { key: 'ArrowLeft' })
    expect(screen.queryByText('Grandchild')).not.toBeInTheDocument()

    fireEvent.keyDown(childA, { key: 'ArrowLeft' })
    expect(screen.getByTestId('selected')).toHaveTextContent('root')

    childB.getBoundingClientRect = vi.fn(
      () => ({ top: 0, height: 40, right: 100, left: 0 }) as DOMRect
    )
    const transfer = dataTransfer()
    fireEvent.dragStart(root, { dataTransfer: transfer })
    expect(transfer.setData).toHaveBeenCalledWith('application/x-memry-tree-node', 'root')

    fireEvent.dragOver(childB, { dataTransfer: transfer, clientY: 38 })
    fireEvent.drop(childB, { dataTransfer: transfer })
    expect(onMove).toHaveBeenCalledWith({
      draggedId: 'root',
      targetId: 'child-b',
      position: 'after'
    })

    fireEvent.click(screen.getAllByRole('button', { name: /setIcon/ })[0])
    act(() => {
      vi.advanceTimersByTime(100)
    })
    fireEvent.click(screen.getByRole('button', { name: 'choose Star' }))
    expect(onIconChange).toHaveBeenCalledWith({
      nodeId: 'root',
      iconName: 'Star',
      hasChildren: true
    })
    expect(screen.getByTestId('root-icon')).toHaveTextContent('Star')

    fireEvent.click(screen.getAllByRole('button', { name: 'clearIcon' })[0])
    expect(onIconChange).toHaveBeenLastCalledWith({
      nodeId: 'root',
      iconName: null,
      hasChildren: true
    })

    fireEvent.dragLeave(childB, { relatedTarget: document.body })
    fireEvent.dragEnd(root)
  })

  it('supports controlled selection, disabled selection, hidden chrome, and outside-context errors', () => {
    const onSelectionChange = vi.fn()
    renderTree({
      selectedIds: ['child-b'],
      onSelectionChange,
      selectable: false,
      showLines: false,
      showIcons: false,
      animateExpand: false
    })

    expect(screen.getByText('Child B').closest('[data-tree-node-id]')).toHaveClass(
      'bg-sidebar-accent'
    )
    fireEvent.click(screen.getByText('Root'))
    expect(onSelectionChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'set missing' }))

    expect(() => render(<TreeView />)).not.toThrow()
    expect(() => render(<TreeNodeTrigger>orphan</TreeNodeTrigger>)).toThrow(
      'Tree components must be used within a TreeProvider'
    )
  })
})

describe('canvas drag payload', () => {
  function renderNode(canvasNoteId?: string) {
    render(
      <TreeProvider persistKey="tree-canvas-test" draggable>
        <TreeView>
          <TreeNode nodeId="note-1" canvasNoteId={canvasNoteId}>
            <TreeNodeTrigger>
              <span>Note One</span>
            </TreeNodeTrigger>
          </TreeNode>
        </TreeView>
      </TreeProvider>
    )
    return screen.getByText('Note One').closest('[draggable]') as HTMLElement
  }

  it('tags a note so the spatial canvas can card it on drop', () => {
    const node = renderNode('note-1')
    const transfer = dataTransfer()

    fireEvent.dragStart(node, { dataTransfer: transfer })

    expect(transfer.setData).toHaveBeenCalledWith(
      CANVAS_ITEM_DRAG_MIME,
      JSON.stringify({ entityType: 'note', entityId: 'note-1' })
    )
    // Chromium refuses a drop whose dropEffect is not permitted by
    // effectAllowed, and the canvas asks for 'copy'. Leaving this at the
    // tree's own 'move' silently kills the drop with no visible error.
    expect(transfer.effectAllowed).toBe('copyMove')
  })

  it('still carries the tree payload its own reordering needs', () => {
    const node = renderNode('note-1')
    const transfer = dataTransfer()

    fireEvent.dragStart(node, { dataTransfer: transfer })

    expect(transfer.setData).toHaveBeenCalledWith('application/x-memry-tree-node', 'note-1')
  })

  it('leaves a node with no canvas entity untouched', () => {
    const node = renderNode(undefined)
    const transfer = dataTransfer()

    fireEvent.dragStart(node, { dataTransfer: transfer })

    expect(transfer.setData).toHaveBeenCalledTimes(1)
    expect(transfer.setData).toHaveBeenCalledWith('application/x-memry-tree-node', 'note-1')
    expect(transfer.effectAllowed).toBe('move')
  })
})
