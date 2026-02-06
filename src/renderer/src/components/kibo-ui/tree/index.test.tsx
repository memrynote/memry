import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  TreeLabel,
  TreeNode,
  TreeNodeTrigger,
  TreeProvider,
  TreeView
} from '@/components/kibo-ui/tree'

describe('TreeNodeTrigger drag payload', () => {
  it('uses app-specific mime type instead of text/plain', () => {
    render(
      <TreeProvider draggable={true}>
        <TreeView>
          <TreeNode nodeId="note-1">
            <TreeNodeTrigger>
              <TreeLabel>Note 1</TreeLabel>
            </TreeNodeTrigger>
          </TreeNode>
        </TreeView>
      </TreeProvider>
    )

    const trigger = screen.getByText('Note 1').closest('[data-tree-node-id="note-1"]')
    expect(trigger).not.toBeNull()

    const setData = vi.fn()
    const dataTransfer = {
      effectAllowed: 'none',
      setData
    } as unknown as DataTransfer

    fireEvent.dragStart(trigger as HTMLElement, { dataTransfer })

    expect(dataTransfer.effectAllowed).toBe('move')
    expect(setData).toHaveBeenCalledWith('application/x-memry-tree-node-id', 'note-1')
    expect(setData).not.toHaveBeenCalledWith('text/plain', expect.any(String))
  })
})
