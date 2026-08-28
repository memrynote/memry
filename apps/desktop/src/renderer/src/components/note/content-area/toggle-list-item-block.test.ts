import { afterEach, describe, expect, it } from 'vitest'
import { createToggleListItemBlock } from './toggle-list-item-block'

const spec = createToggleListItemBlock() as unknown as {
  implementation: {
    render: (block: unknown, editor: unknown) => { dom: HTMLElement; destroy?: () => void }
    toExternalHTML: (block: unknown) => { dom: HTMLElement; contentDOM: HTMLElement }
  }
}

function toggleBlock(open: boolean, id = 'blk-1') {
  return {
    id,
    type: 'toggleListItem',
    props: { backgroundColor: 'default', textColor: 'default', textAlignment: 'left', open },
    content: [],
    children: [{ id: 'child', type: 'paragraph', props: {}, content: [], children: [] }]
  }
}

/** Only the surface `createToggleWrapper` reaches for. */
function stubEditor(block: unknown) {
  const updates: unknown[] = []
  return {
    updates,
    editor: {
      isEditable: true,
      dictionary: { toggle_blocks: { add_block_button: 'Add block' } },
      getBlock: () => block,
      onChange: () => () => {},
      transact: (fn: () => void) => fn(),
      updateBlock: (_target: unknown, update: unknown) => {
        updates.push(update)
        return block
      }
    }
  }
}

function render(block: unknown, editor: unknown): HTMLElement {
  return spec.implementation.render(block, editor).dom
}

afterEach(() => {
  window.localStorage.clear()
})

describe('toggleListItem fold (#1847)', () => {
  it('shows children when the block prop says the toggle is open', () => {
    const block = toggleBlock(true)
    const dom = render(block, stubEditor(block).editor)

    expect(dom.querySelector('.bn-toggle-wrapper')?.getAttribute('data-show-children')).toBe('true')
  })

  it('hides them when it says closed', () => {
    const block = toggleBlock(false)
    const dom = render(block, stubEditor(block).editor)

    expect(dom.querySelector('.bn-toggle-wrapper')?.getAttribute('data-show-children')).toBe(
      'false'
    )
  })

  it('ignores the localStorage key BlockNote used to keep the fold in', () => {
    // #given a stale `toggle-<id>` entry saying open, of the kind every build so
    // far wrote — the block id it is keyed by is minted fresh on each parse, so
    // entries like this outlive the block they described
    window.localStorage.setItem('toggle-blk-1', 'true')
    const block = toggleBlock(false)

    // #when
    const dom = render(block, stubEditor(block).editor)

    // #then the document wins
    expect(dom.querySelector('.bn-toggle-wrapper')?.getAttribute('data-show-children')).toBe(
      'false'
    )
  })

  it('writes the fold back to the block, not to localStorage', () => {
    const block = toggleBlock(false)
    const { editor, updates } = stubEditor(block)
    const dom = render(block, editor)

    dom.querySelector<HTMLButtonElement>('.bn-toggle-button')!.click()

    expect(updates).toEqual([{ props: { open: true } }])
    expect(window.localStorage.getItem('toggle-blk-1')).toBeNull()
  })

  // The same string `server-specs.ts` builds for main. A toggle on a page never
  // reaches this — the save path writes those as `<details>` — but one nested
  // under a list item does, and drift between the two would rewrite its bytes.
  // A collapsed toggle carries no `data-open` at all: BlockNote omits a prop
  // sitting at its default, so this HTML is what the block exported before the
  // prop existed.
  it.each([
    [true, ' data-open="true"'],
    [false, '']
  ])('exports the li/p DOM main builds, open=%s', (open, attr) => {
    const { dom, contentDOM } = spec.implementation.toExternalHTML(toggleBlock(open))

    expect(dom.outerHTML).toBe(
      `<div class="bn-block-content" data-content-type="toggleListItem"${attr}>` +
        '<li><p class="bn-inline-content"></p></li></div>'
    )
    expect(contentDOM.tagName).toBe('P')
  })
})
