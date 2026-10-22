/**
 * What each window gesture does to the definition, read from a real window.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { parsePortalDefinition, type PortalDefinition } from '@memry/shared/portal-block'
import type { PartialBlock } from '@blocknote/core'

vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))
vi.mock('@/lib/url-metadata', () => ({
  fetchLinkPreview: vi.fn().mockResolvedValue({ domain: '', title: '', favicon: '' })
}))

import { para, unmountTestEditors } from './portal-test-editor'
import { mountPortalWindow } from './portal-window-test-editor'
import {
  planBackspaceAtStart,
  planExpandAll,
  planHide,
  planIncludeParent,
  planReconcile,
  planShow,
  planShowAllSiblings
} from './portal-plans'
import { getPortalWindowState } from './portal-window-plugin'

afterEach(unmountTestEditors)

function define(json: Record<string, unknown>): PortalDefinition {
  const parsed = parsePortalDefinition(JSON.stringify({ v: 1, note: 'src', ...json }))
  if (!parsed.ok) throw new Error('bad definition')
  return parsed.definition
}

function mount(blocks: PartialBlock[], def: PortalDefinition) {
  if (def.target.kind === 'search') throw new Error('search')
  const mounted = mountPortalWindow(blocks, def.target)
  const id = (text: string): string => {
    const state = getPortalWindowState(mounted.view)!
    const all = [
      ...state.visible,
      ...state.hiddenSiblings,
      ...Object.values(state.hiddenChildren).flat(),
      ...state.ancestors
    ]
    const found = all.find((b) => b.text === text)
    if (!found) throw new Error(`no block ${text}`)
    return found.blockId
  }
  return { ...mounted, id, def }
}

const tree = (): PartialBlock[] => [
  para('Parent ^par111', [
    para('Root ^root1', [para('kid a ^kida1'), para('kid b ^kidb2'), para('bare kid')]),
    para('Sibling one ^sib111'),
    para('Sibling two')
  ])
]

describe('planHide', () => {
  it('drops a root when another remains', () => {
    const { view, def, id } = mount(tree(), define({ blocks: ['root1', 'sib111'] }))
    const plan = planHide(view, def, id('Root'))
    expect(plan?.stamp).toBeUndefined()
    expect(plan?.definition.target).toMatchObject({ blocks: ['sib111'] })
  })

  it('refuses to hide the only root', () => {
    const { view, def, id } = mount(tree(), define({ blocks: ['root1'] }))
    expect(planHide(view, def, id('Root'))).toBeNull()
  })

  it('adds an anchored child to the hide list in hide-mode', () => {
    const { view, def, id } = mount(
      tree(),
      define({ blocks: ['root1'], open: { root1: { hide: [] } } })
    )
    const plan = planHide(view, def, id('kid a'))
    expect(plan?.definition.target).toMatchObject({
      open: { root1: { mode: 'hide', ids: ['kida1'] } }
    })
  })

  it('asks for a stamp when hiding an unanchored child in hide-mode, then finishes with it', () => {
    const { view, def, id } = mount(
      tree(),
      define({ blocks: ['root1'], open: { root1: { hide: [] } } })
    )
    const bare = id('bare kid')
    const plan = planHide(view, def, bare)!
    expect(plan.stamp).toEqual([bare])
    expect(plan.definition).toBe(def)

    const done = plan.resolve({ [bare]: 'bare11' })
    expect(done.stamp).toBeUndefined()
    expect(done.definition.target).toMatchObject({
      open: { root1: { mode: 'hide', ids: ['bare11'] } }
    })
  })

  it('removes a child from a show list without stamping', () => {
    const { view, def, id } = mount(
      tree(),
      define({ blocks: ['root1'], open: { root1: { show: ['kida1', 'kidb2'] } } })
    )
    const plan = planHide(view, def, id('kid a'))
    expect(plan?.stamp).toBeUndefined()
    expect(plan?.definition.target).toMatchObject({
      open: { root1: { mode: 'show', ids: ['kidb2'] } }
    })
  })
})

describe('planShow', () => {
  it('lists a hidden child of a collapsed block, stamping it when needed', () => {
    const { view, def, id } = mount(tree(), define({ blocks: ['root1'] }))
    const plan = planShow(view, def, id('kid b'))
    expect(plan?.stamp).toBeUndefined()
    expect(plan?.definition.target).toMatchObject({
      open: { root1: { mode: 'show', ids: ['kidb2'] } }
    })

    const bare = id('bare kid')
    expect(planShow(view, def, bare)?.stamp).toEqual([bare])
  })

  it('removes a child from a hide list', () => {
    const { view, def, id } = mount(
      tree(),
      define({ blocks: ['root1'], open: { root1: { hide: ['kidb2'] } } })
    )
    expect(planShow(view, def, id('kid b'))?.definition.target).toMatchObject({
      open: { root1: { mode: 'hide', ids: [] } }
    })
  })

  it('makes a hidden sibling a root', () => {
    const { view, def, id } = mount(tree(), define({ blocks: ['root1'] }))
    expect(planShow(view, def, id('Sibling one'))?.definition.target).toMatchObject({
      blocks: ['root1', 'sib111']
    })
  })
})

describe('planExpandAll', () => {
  it('opens every child and asks to stamp an unanchored block first', () => {
    const { view, def, id } = mount(tree(), define({ blocks: ['root1'] }))
    expect(planExpandAll(view, def, id('Root'))?.definition.target).toMatchObject({
      open: { root1: { mode: 'hide', ids: [] } }
    })

    const withBare = mount(
      [para('Root ^root2', [para('x')])],
      define({ blocks: ['root2'], open: { root2: { hide: [] } } })
    )
    const bare = withBare.id('x')
    const plan = planExpandAll(withBare.view, withBare.def, bare)
    expect(plan?.stamp).toEqual([bare])
  })
})

describe('planIncludeParent', () => {
  it('replaces the roots with the parent and shows what was visible', () => {
    const { view, def, id } = mount(
      tree(),
      define({ blocks: ['root1'], open: { root1: { hide: [] } } })
    )
    const plan = planIncludeParent(view, def, id('Parent'))
    expect(plan?.definition.target).toMatchObject({
      blocks: ['par111'],
      open: { par111: { mode: 'show', ids: ['root1'] }, root1: { mode: 'hide', ids: [] } }
    })
  })

  it('walks up through every block between the root and a distant ancestor', () => {
    const doc = [para('Top ^top111', [para('Mid ^mid111', [para('Leaf ^leaf11')])])]
    const { view, def, id } = mount(doc, define({ blocks: ['leaf11'] }))
    const plan = planIncludeParent(view, def, id('Top'))
    expect(plan?.definition.target).toMatchObject({
      blocks: ['top111'],
      open: { top111: { mode: 'show', ids: ['mid111'] }, mid111: { mode: 'show', ids: ['leaf11'] } }
    })
  })

  it('asks to stamp ancestors without an anchor', () => {
    const { view, def, id } = mount(
      [para('Bare parent', [para('Leaf ^leaf11')])],
      define({ blocks: ['leaf11'] })
    )
    const parent = id('Bare parent')
    expect(planIncludeParent(view, def, parent)?.stamp).toEqual([parent])
  })
})

describe('planShowAllSiblings', () => {
  it('appends every hidden sibling of the roots, stamping the bare ones', () => {
    const { view, def, id } = mount(tree(), define({ blocks: ['root1'] }))
    const two = id('Sibling two')
    const plan = planShowAllSiblings(view, def)!
    expect(plan.stamp).toEqual([two])
    expect(plan.resolve({ [two]: 'sib222' }).definition.target).toMatchObject({
      blocks: ['root1', 'sib111', 'sib222']
    })
  })

  it('does nothing when no sibling is hidden', () => {
    const { view, def } = mount([para('Only ^only11')], define({ blocks: ['only11'] }))
    expect(planShowAllSiblings(view, def)).toBeNull()
  })
})

describe('planReconcile', () => {
  const created = (view: ReturnType<typeof mount>['view'], text: string) => {
    let id = ''
    view.state.doc.descendants((node) => {
      if (node.type.name === 'blockContainer' && node.firstChild?.textContent === text) {
        id = String(node.attrs.id)
      }
    })
    return id
  }

  it('lists a new sibling of a root as a root, after the root it follows', () => {
    const { view, def, editor } = mount(
      [para('Root ^root1'), para('other')],
      define({ blocks: ['root1'] })
    )
    editor.insertBlocks([para('new')], editor.document[0], 'after')
    const id = created(view, 'new')

    const plan = planReconcile(view, def, [id])!
    expect(plan.stamp).toEqual([id])
    expect(plan.resolve({ [id]: 'new111' }).definition.target).toMatchObject({
      blocks: ['root1', 'new111']
    })
  })

  it('lists a child created under a collapsed block', () => {
    const { view, def, editor } = mount(
      [para('Root ^root1', [para('old')])],
      define({ blocks: ['root1'] })
    )
    editor.insertBlocks([para('new')], editor.document[0].children[0], 'after')
    const id = created(view, 'new')

    const plan = planReconcile(view, def, [id])!
    expect(plan.resolve({ [id]: 'new111' }).definition.target).toMatchObject({
      open: { root1: { mode: 'show', ids: ['new111'] } }
    })
  })

  it('decides from where the block ended up: a root-level block moved under a root is a child', () => {
    const { view, def, editor } = mount(
      [para('Root ^root1'), para('new')],
      define({ blocks: ['root1'] })
    )
    const id = created(view, 'new')
    editor.setTextCursorPosition(editor.document[1], 'start')
    editor.nestBlock()

    const plan = planReconcile(view, def, [id])!
    expect(plan.resolve({ [id]: 'new111' }).definition.target).toMatchObject({
      blocks: ['root1'],
      open: { root1: { mode: 'show', ids: ['new111'] } }
    })
  })

  it('moves a block listed as a root into its parent once Tab nests it', () => {
    const def = define({ blocks: ['root1', 'new111'] })
    const { view, editor } = mount([para('Root ^root1'), para('new ^new111')], def)
    editor.setTextCursorPosition(editor.document[1], 'start')
    editor.nestBlock()
    const id = created(view, 'new ^new111')

    const plan = planReconcile(view, def, [id])!
    expect(plan.stamp).toBeUndefined()
    expect(plan.definition.target).toMatchObject({
      blocks: ['root1'],
      open: { root1: { mode: 'show', ids: ['new111'] } }
    })
  })

  it('leaves a listed root alone while it is still a sibling of the roots', () => {
    const def = define({ blocks: ['root1', 'new111'] })
    const { view } = mount([para('Root ^root1'), para('new ^new111')], def)

    expect(planReconcile(view, def, [created(view, 'new ^new111')])).toBeNull()
  })

  it('lists nothing for a nested block under a hide-mode parent, and drops it from the roots', () => {
    const def = define({ blocks: ['root1', 'new111'], open: { root1: { hide: [] } } })
    const { view, editor } = mount([para('Root ^root1'), para('new ^new111')], def)
    editor.setTextCursorPosition(editor.document[1], 'start')
    editor.nestBlock()

    const plan = planReconcile(view, def, [created(view, 'new ^new111')])!
    expect(plan.definition.target).toMatchObject({
      blocks: ['root1'],
      open: { root1: { mode: 'hide', ids: [] } }
    })
  })

  it('places several new blocks in order, a block under another new block included', () => {
    const { view, def, editor } = mount([para('Root ^root1')], define({ blocks: ['root1'] }))
    editor.insertBlocks([para('first'), para('second')], editor.document[0], 'after')
    const [a, b] = [created(view, 'first'), created(view, 'second')]

    const plan = planReconcile(view, def, [b, a])!
    expect(plan.stamp).toEqual([a, b])
    expect(plan.resolve({ [a]: 'aaa111', [b]: 'bbb222' }).definition.target).toMatchObject({
      blocks: ['root1', 'aaa111', 'bbb222']
    })
  })

  it('needs nothing for a child under a hide-mode block, nothing for a whole note, nothing outside the slice', () => {
    const open = define({ blocks: ['root1'], open: { root1: { hide: [] } } })
    const a = mount([para('Root ^root1', [para('old')])], open)
    a.editor.insertBlocks([para('new')], a.editor.document[0].children[0], 'before')
    expect(planReconcile(a.view, open, [created(a.view, 'new')])).toBeNull()

    const note = define({})
    const b = mount([para('x')], note)
    b.editor.insertBlocks([para('new')], b.editor.document[0], 'after')
    expect(planReconcile(b.view, note, [created(b.view, 'new')])).toBeNull()

    const root = define({ blocks: ['root1'] })
    const c = mount([para('Parent', [para('Root ^root1')])], root)
    c.editor.insertBlocks([para('new')], c.editor.document[0], 'after')
    expect(planReconcile(c.view, root, [created(c.view, 'new')])).toBeNull()
  })

  it('leaves an empty block that holds the caret for later', () => {
    const { view, def, editor } = mount([para('Root ^root1')], define({ blocks: ['root1'] }))
    editor.insertBlocks([para('')], editor.document[0], 'after')
    editor.setTextCursorPosition(editor.document[1], 'start')
    const id = String(editor.document[1].id)

    expect(planReconcile(view, def, [id])).toBeNull()
  })
})

describe('planBackspaceAtStart', () => {
  it('stops listing an empty root that Backspace will delete, unless it is the only one', () => {
    const doc = [para('A ^aaa111'), para(' ^bbb222')]
    const both = define({ blocks: ['aaa111', 'bbb222'] })
    const { view, editor } = mount(doc, both)
    editor.setTextCursorPosition(editor.document[1], 'start')

    expect(planBackspaceAtStart(view, both)?.definition.target).toMatchObject({
      blocks: ['aaa111']
    })

    const only = define({ blocks: ['bbb222'] })
    const alone = mount(doc, only)
    alone.editor.setTextCursorPosition(alone.editor.document[1], 'start')
    expect(planBackspaceAtStart(alone.view, only)).toBeNull()
  })
})
