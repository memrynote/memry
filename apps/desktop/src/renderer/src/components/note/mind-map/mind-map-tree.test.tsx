/**
 * The map's accessible twin, driven the way a person drives it.
 *
 * This layer exists so the map is reachable without sight and without a mouse;
 * these assertions are what make that claim true rather than aspirational. They
 * are also the only way any harness can reach a node, since the picture beside
 * this tree is a bitmap.
 */

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { buildMindMap } from './build-mind-map'
import { MindMapTree } from './mind-map-tree'
import type { MindMapSourceBlock } from './mind-map-types'

function heading(id: string, level: number, text: string): MindMapSourceBlock {
  return { id, type: 'heading', props: { level }, content: [{ type: 'text', text }] }
}

const map = buildMindMap(
  [heading('b-alpha', 1, 'Alpha'), heading('b-beta', 2, 'Beta'), heading('b-gamma', 1, 'Gamma')],
  { rootLabel: 'Test Note', noteId: 'note-1' }
)

/** Kept apart so the arrow-key walk above stays the shape it was written for. */
const linkedMap = buildMindMap(
  [
    heading('b-alpha', 1, 'Alpha'),
    {
      id: 'b-item',
      type: 'bulletListItem',
      content: [{ type: 'wikiLink', props: { target: 'Roadmap#Q3', alias: 'the plan' } }]
    }
  ],
  { rootLabel: 'Test Note', noteId: 'note-1' }
)

function renderTree(): { onActivateNode: ReturnType<typeof vi.fn>; items: HTMLElement[] } {
  const onActivateNode = vi.fn()
  render(
    <MindMapTree
      nodes={map.nodes}
      label="Map of Test Note"
      linkHint="link to another page"
      onActivateNode={onActivateNode}
    />
  )
  const items = within(screen.getByRole('tree')).getAllByRole('treeitem')
  return { onActivateNode, items }
}

/** The item standing for a node, by the node id it carries. */
function itemFor(items: HTMLElement[], label: string): HTMLElement {
  const node = map.nodes.find((candidate) => candidate.label === label)!
  const item = items.find((candidate) => candidate.dataset.mindMapNode === node.id)
  if (!item) throw new Error(`no tree item for ${label}`)
  return item
}

describe('MindMapTree', () => {
  it('activates the node that was clicked, and only that node', () => {
    const { onActivateNode, items } = renderTree()

    fireEvent.click(itemFor(items, 'Beta'))

    // Items nest, so without stopping the event a click on a leaf would also
    // activate every ancestor it happens to sit inside.
    expect(onActivateNode).toHaveBeenCalledTimes(1)
    expect(onActivateNode.mock.calls[0][0]).toMatchObject({ blockId: 'b-beta', kind: 'heading' })
  })

  it('activates the root, which stands for the note itself', () => {
    const { onActivateNode, items } = renderTree()

    fireEvent.click(itemFor(items, 'Test Note'))

    expect(onActivateNode).toHaveBeenCalledTimes(1)
    expect(onActivateNode.mock.calls[0][0]).toMatchObject({ blockId: null, kind: 'root' })
  })

  it('activates from the keyboard exactly as a click does', () => {
    const { onActivateNode, items } = renderTree()
    const beta = itemFor(items, 'Beta')

    fireEvent.keyDown(beta, { key: 'Enter' })
    fireEvent.keyDown(beta, { key: ' ' })
    fireEvent.click(beta)

    expect(onActivateNode).toHaveBeenCalledTimes(3)
    const [enter, space, click] = onActivateNode.mock.calls
    expect(enter).toEqual(click)
    expect(space).toEqual(click)
  })

  it('keeps one tab stop and moves focus with the arrows', () => {
    const { items } = renderTree()

    // A note with fifty headings must not become fifty invisible tab stops.
    expect(items.filter((item) => item.tabIndex === 0)).toHaveLength(1)
    expect(itemFor(items, 'Test Note').tabIndex).toBe(0)

    const root = itemFor(items, 'Test Note')
    root.focus()
    fireEvent.keyDown(root, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(itemFor(items, 'Alpha'))

    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(document.activeElement).toBe(itemFor(items, 'Gamma'))

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(itemFor(items, 'Beta'))

    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(document.activeElement).toBe(root)
  })

  it('moves the tab stop to wherever focus landed', () => {
    const { items } = renderTree()
    const root = itemFor(items, 'Test Note')

    root.focus()
    fireEvent.keyDown(root, { key: 'ArrowDown' })

    // Tabbing away and back returns the user to where they were, not to the top.
    expect(itemFor(items, 'Alpha').tabIndex).toBe(0)
    expect(root.tabIndex).toBe(-1)
  })

  it('says a wiki-link node leaves the note, and activates it like any other', () => {
    const onActivateNode = vi.fn()
    render(
      <MindMapTree
        nodes={linkedMap.nodes}
        label="Map of Test Note"
        linkHint="link to another page"
        onActivateNode={onActivateNode}
      />
    )
    const node = linkedMap.nodes.find((candidate) => candidate.kind === 'wikiLink')!
    const item = screen
      .getByRole('tree')
      .querySelector<HTMLElement>(`[data-mind-map-node="${node.id}"]`)!

    // The picture says this with a colour and a dashed outline; a reader of
    // this tree cannot see either, so it is said in words.
    expect(item).toHaveTextContent('the plan link to another page')
    expect(item).toHaveAttribute('data-mind-map-kind', 'wikiLink')
    // A leaf: no group, and nothing to expand.
    expect(item).not.toHaveAttribute('aria-expanded')
    expect(item).not.toHaveAttribute('aria-checked')

    fireEvent.keyDown(item, { key: 'Enter' })
    fireEvent.click(item)

    expect(onActivateNode).toHaveBeenCalledTimes(2)
    expect(onActivateNode.mock.calls[0]).toEqual(onActivateNode.mock.calls[1])
    expect(onActivateNode.mock.calls[0][0]).toMatchObject({
      kind: 'wikiLink',
      wikiTarget: 'Roadmap#Q3',
      blockId: null
    })
  })

  it('does not activate anything on an arrow key', () => {
    const { onActivateNode, items } = renderTree()
    const root = itemFor(items, 'Test Note')

    root.focus()
    fireEvent.keyDown(root, { key: 'ArrowDown' })

    expect(onActivateNode).not.toHaveBeenCalled()
  })
})
