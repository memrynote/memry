/**
 * The keys at the edges of a window, on a real editor: what Enter, Backspace,
 * Shift+Tab and the arrows do where the window ends.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TextSelection } from '@tiptap/pm/state'
import { ySyncPluginKey } from 'y-prosemirror'
import type { PartialBlock } from '@blocknote/core'
import type { PortalOpen } from '@memry/shared/portal-block'

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
  PORTAL_EXIT_EVENT,
  PORTAL_SELECT_EVENT,
  RECONCILE_DELAY_MS,
  moveAcrossVisible
} from './portal-boundary-plugin'
import type { PortalPlan } from './portal-plans'
import { anchorVisibleEnd } from './anchor-visibility-plugin'
import { getPortalWindowState, type PortalWindowSpec } from './portal-window-plugin'

afterEach(unmountTestEditors)

const target = (blocks: string[], open: Record<string, PortalOpen> = {}): PortalWindowSpec => ({
  kind: 'blocks',
  note: 'src',
  blocks,
  open
})

function mount(blocks: PartialBlock[], spec: PortalWindowSpec) {
  const plans: PortalPlan[] = []
  const mounted = mountPortalWindow(blocks, spec, {
    onPlan: (plan) => {
      plans.push(plan)
    }
  })
  const events: Array<{ type: string; detail: unknown }> = []
  for (const eventType of [PORTAL_EXIT_EVENT, PORTAL_SELECT_EVENT]) {
    mounted.view.dom.addEventListener(eventType, (e) =>
      events.push({ type: eventType, detail: (e as CustomEvent).detail })
    )
  }
  return { ...mounted, plans, events }
}

type View = ReturnType<typeof mount>['view']

/** Caret in the block with this text (without anchor), at the start or the visible end. */
function caretIn(view: View, text: string, at: 'start' | 'end'): void {
  let caret = -1
  view.state.doc.descendants((node, pos) => {
    if (!node.isTextblock || node.textContent.replace(/ \^[a-z0-9-]+$/, '') !== text) return
    caret = at === 'start' ? pos + 1 : anchorVisibleEnd(view.state.doc.resolve(pos + 1))
  })
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, caret)))
}

function press(view: View, key: string, init: KeyboardEventInit = {}): void {
  view.dom.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  )
}

const texts = (view: View): string[] =>
  view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n').split('\n').filter(Boolean)

/** Type like the keyboard does: one transaction per character at the caret. */
function type(view: View, text: string): void {
  for (const ch of text) view.dispatch(view.state.tr.insertText(ch))
}

/** Whether the block holding `text` is hidden by the window. */
function isHidden(view: View, text: string): boolean {
  let hidden = false
  const decos = getPortalWindowState(view)!.hiddenSpans
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === 'blockContainer' && node.firstChild?.textContent === text) {
      hidden = decos.some((s) => pos >= s.from && pos < s.to)
    }
  })
  return hidden
}

const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(RECONCILE_DELAY_MS + 1)
}

describe('Enter', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  describe('the anchor stays on the block that keeps the text', () => {
    const kinds: Array<[string, (text: string, children?: PartialBlock[]) => PartialBlock]> = [
      ['paragraph', para],
      ['bullet item', (text, children) => ({ type: 'bulletListItem', content: text, children })],
      [
        'numbered item',
        (text, children) => ({ type: 'numberedListItem', content: text, children })
      ],
      ['checklist item', (text, children) => ({ type: 'checkListItem', content: text, children })],
      [
        'heading',
        (text, children) => ({ type: 'heading', props: { level: 2 }, content: text, children })
      ]
    ]
    for (const [kind, make] of kinds) {
      const cases: Array<[string, PartialBlock[], PortalWindowSpec, string, string[]]> = [
        [
          'last root',
          [make('Root ^root1'), para('hidden')],
          target(['root1']),
          'Root',
          ['Root ^root1', 'next', 'hidden']
        ],
        [
          'child of a show-mode parent',
          [para('Root ^root1', [make('kid ^kid111')])],
          target(['root1'], { root1: { mode: 'show', ids: ['kid111'] } }),
          'kid',
          ['Root ^root1', 'kid ^kid111', 'next']
        ],
        [
          'child of a hide-mode parent',
          [para('Root ^root1', [make('kid ^kid111')])],
          target(['root1'], { root1: { mode: 'hide', ids: [] } }),
          'kid',
          ['Root ^root1', 'kid ^kid111', 'next']
        ],
        [
          'shown child between hidden siblings',
          [para('Root ^root1', [para('a ^aaa111'), make('kid ^kid111'), para('b ^bbb111')])],
          target(['root1'], { root1: { mode: 'show', ids: ['kid111'] } }),
          'kid',
          ['Root ^root1', 'a ^aaa111', 'kid ^kid111', 'next', 'b ^bbb111']
        ]
      ]
      for (const [name, blocks, spec, caret, expected] of cases) {
        it(`Enter at the visible end of a childless ${kind} (${name}) leaves the anchor on it`, async () => {
          const { view } = mount(blocks, spec)
          caretIn(view, caret, 'end')
          press(view, 'Enter')
          type(view, 'next')
          await settle()
          expect(texts(view)).toEqual(expected)
        })
      }
    }

    it('Shift+Enter in a window keeps the anchor at the end of the same block', () => {
      const { view, editor } = mount(
        [para('Root ^root1', [para('kid ^kid111')])],
        target(['root1'], { root1: { mode: 'show', ids: ['kid111'] } })
      )
      caretIn(view, 'kid', 'end')
      press(view, 'Enter', { shiftKey: true })
      expect(editor.document[0].children).toHaveLength(1)
      const text = view.state.doc.textContent
      expect(text.match(/\^kid111/g)).toHaveLength(1)
      expect(text.endsWith(' ^kid111')).toBe(true)
    })
  })

  it('at the end of the last root keeps the new block visible and, once typed in, lists it as a root', async () => {
    const { view, editor, plans } = mount([para('Root ^root1'), para('hidden')], target(['root1']))
    caretIn(view, 'Root', 'end')

    press(view, 'Enter')
    type(view, 'next')

    expect(editor.document).toHaveLength(3)
    expect(isHidden(view, 'next')).toBe(false)
    expect(plans).toHaveLength(0)
    await settle()
    expect(plans).toHaveLength(1)
    const [id] = plans[0].stamp!
    expect(plans[0].resolve({ [id]: 'new111' }).definition.target).toMatchObject({
      blocks: ['root1', 'new111']
    })
  })

  it('at the end of a child of a show-mode parent lists the new child under it', async () => {
    const { view, plans } = mount(
      [para('Root ^root1', [para('kid ^kid111')])],
      target(['root1'], { root1: { mode: 'show', ids: ['kid111'] } })
    )
    caretIn(view, 'kid', 'end')

    press(view, 'Enter')
    type(view, 'more')
    await settle()

    const [id] = plans[0].stamp!
    expect(plans[0].resolve({ [id]: 'new111' }).definition.target).toMatchObject({
      open: { root1: { mode: 'show', ids: ['kid111', 'new111'] } }
    })
  })

  it('writes nothing for a new child under a hide-mode parent: it is visible already', async () => {
    const { view, plans } = mount(
      [para('Root ^root1', [para('kid ^kid111')])],
      target(['root1'], { root1: { mode: 'hide', ids: [] } })
    )
    caretIn(view, 'kid', 'end')

    press(view, 'Enter')
    type(view, 'more')
    await settle()

    expect(isHidden(view, 'more')).toBe(false)
    expect(plans).toHaveLength(0)
  })

  it('past a block whose children are hidden puts the new block after them, then Tab makes it the last child', async () => {
    const { view, plans } = mount(
      [para('Root ^root1', [para('old ^old111')]), para('tail')],
      target(['root1'])
    )
    caretIn(view, 'Root', 'end')

    press(view, 'Enter')
    press(view, 'Tab')
    type(view, 'child')

    expect(texts(view)).toEqual(['Root ^root1', 'old ^old111', 'child', 'tail'])
    expect(view.state.doc.child(0).child(0).childCount).toBe(2) // root: content + group
    expect(isHidden(view, 'child')).toBe(false)
    await settle()
    expect(plans).toHaveLength(1)
    const [rootId, childId] = [...(plans[0].stamp ?? [])]
    expect(rootId ?? childId).toBeTruthy()
    const [id] = plans[0].stamp!
    expect(plans[0].resolve({ [id]: 'new111' }).definition.target).toMatchObject({
      blocks: ['root1'],
      open: { root1: { mode: 'show', ids: ['new111'] } }
    })
  })

  it('at the end of an expanded parent makes the new block its first child and keeps the children', async () => {
    const { view, plans } = mount(
      [para('Root ^root1', [para('old ^old111')])],
      target(['root1'], { root1: { mode: 'hide', ids: [] } })
    )
    caretIn(view, 'Root', 'end')

    press(view, 'Enter')
    type(view, 'first')
    await settle()

    expect(texts(view)).toEqual(['Root ^root1', 'first', 'old ^old111'])
    expect(isHidden(view, 'first')).toBe(false)
    expect(plans).toHaveLength(0)
  })

  it('keeps every keystroke in the new block while the fence write is still in flight', async () => {
    let release: () => void = () => undefined
    const { view, plans } = (() => {
      const recorded: PortalPlan[] = []
      const mounted = mountPortalWindow(
        [para('Root ^root1', [para('old ^old111')])],
        target(['root1']),
        {
          onPlan: (plan) => {
            recorded.push(plan)
            return new Promise<void>((resolve) => (release = resolve))
          }
        }
      )
      return { ...mounted, plans: recorded }
    })()
    caretIn(view, 'Root', 'end')

    press(view, 'Enter')
    press(view, 'Tab')
    type(view, 'abc')
    await settle()
    expect(plans).toHaveLength(1)

    // The stamp and fence write have not landed. Typing carries on in the same block.
    type(view, 'def')
    await settle()
    expect(view.state.selection.$head.parent.textContent).toBe('abcdef')
    expect(isHidden(view, 'abcdef')).toBe(false)
    expect(plans).toHaveLength(1)

    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(view.state.selection.$head.parent.textContent).toBe('abcdef')
  })

  it('does not place an empty block that holds the caret', async () => {
    const { view, plans } = mount([para('Root ^root1')], target(['root1']))
    caretIn(view, 'Root', 'end')

    press(view, 'Enter')
    await settle()

    expect(plans).toHaveLength(0)
    expect(isHidden(view, '')).toBe(false)
  })

  it('mid-text keeps the anchor on the first half and lists the second half as a root', async () => {
    const { view, plans } = mount([para('Root ^root1')], target(['root1']))
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 5)))

    press(view, 'Enter')
    await settle()

    expect(texts(view)).toEqual(['Ro ^root1', 'ot'])
    expect(isHidden(view, 'ot')).toBe(false)
    const [id] = plans[0].stamp!
    expect(plans[0].resolve({ [id]: 'new111' }).definition.target).toMatchObject({
      blocks: ['root1', 'new111']
    })
  })

  it('on an empty last line leaves the window after the portal, without editing', () => {
    const { view, events } = mount(
      [para('Root ^root1'), para(' ^new111')],
      target(['root1', 'new111'])
    )
    caretIn(view, '', 'end')
    const before = texts(view)

    press(view, 'Enter')

    expect(events).toEqual([{ type: PORTAL_EXIT_EVENT, detail: { direction: 'after' } }])
    expect(texts(view)).toEqual(before)
  })

  it('on an empty line made here, leaves the window and drops the unused line', () => {
    const { view, events } = mount([para('Root ^root1'), para('tail')], target(['root1']))
    caretIn(view, 'Root', 'end')
    press(view, 'Enter')
    expect(texts(view)).toEqual(['Root ^root1', 'tail'])
    expect(view.state.doc.childCount).toBe(1)
    expect(view.state.doc.child(0).childCount).toBe(3)

    press(view, 'Enter')

    expect(view.state.doc.child(0).childCount).toBe(2)
    expect(events).toEqual([{ type: PORTAL_EXIT_EVENT, detail: { direction: 'after' } }])
  })
})

describe('Backspace', () => {
  it('at the start of the first root selects the portal in the host and changes nothing', () => {
    const { view, events } = mount([para('before'), para('Root ^root1')], target(['root1']))
    caretIn(view, 'Root', 'start')
    const before = texts(view)

    press(view, 'Backspace')

    expect(events).toEqual([{ type: PORTAL_SELECT_EVENT, detail: null }])
    expect(texts(view)).toEqual(before)
  })

  it('merges a block into a visible neighbour as usual', () => {
    const { view, editor } = mount(
      [para('a ^aaa111'), para('b ^bbb222')],
      target(['aaa111', 'bbb222'])
    )
    caretIn(view, 'b', 'start')

    press(view, 'Backspace')

    expect(editor.document).toHaveLength(1)
  })

  it('never merges a later root into hidden content', () => {
    const { view, events } = mount(
      [para('a ^aaa111'), para('hidden'), para('b ^bbb222')],
      target(['aaa111', 'bbb222'])
    )
    caretIn(view, 'b', 'start')
    const before = texts(view)

    press(view, 'Backspace')

    expect(texts(view)).toEqual(before)
    expect(events).toEqual([])
  })

  it('removing an empty second root reports the plan that unlists it', () => {
    const { view, plans } = mount(
      [para('a ^aaa111'), para(' ^bbb222')],
      target(['aaa111', 'bbb222'])
    )
    caretIn(view, '', 'start')

    press(view, 'Backspace')

    expect(plans).toHaveLength(1)
    expect(plans[0].definition.target).toMatchObject({ blocks: ['aaa111'] })
  })
})

describe('Shift+Tab and Tab', () => {
  it('Shift+Tab on a root is a no-op', () => {
    const { view, editor } = mount([para('Parent', [para('Root ^root1')])], target(['root1']))
    caretIn(view, 'Root', 'start')
    const before = JSON.stringify(editor.document)

    press(view, 'Tab', { shiftKey: true })

    expect(JSON.stringify(editor.document)).toBe(before)
  })

  it('Tab never nests a root under a hidden previous sibling', () => {
    const { view, editor } = mount([para('hidden'), para('Root ^root1')], target(['root1']))
    caretIn(view, 'Root', 'start')
    const before = JSON.stringify(editor.document)

    press(view, 'Tab')

    expect(JSON.stringify(editor.document)).toBe(before)
  })

  it('Tab on a first child is swallowed, so the caret stays in the window', () => {
    const { view } = mount(
      [para('Root ^root1', [para('one')])],
      target(['root1'], { root1: { mode: 'hide', ids: [] } })
    )
    caretIn(view, 'one', 'start')
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })

    view.dom.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
  })

  it('Tab nests a child under its visible previous sibling', () => {
    const { view, editor } = mount(
      [para('Root ^root1', [para('one'), para('two')])],
      target(['root1'], { root1: { mode: 'hide', ids: [] } })
    )
    caretIn(view, 'two', 'start')

    press(view, 'Tab')

    expect(editor.document[0].children[0].children).toHaveLength(1)
  })
})

describe('moveAcrossVisible', () => {
  const doc = (): PartialBlock[] => [
    para('hidden top'),
    para('a ^aaa111'),
    para('hidden middle'),
    para('b ^bbb222'),
    para('hidden bottom')
  ]

  it('skips hidden blocks between visible ones', () => {
    const { view } = mount(doc(), target(['aaa111', 'bbb222']))
    caretIn(view, 'a', 'end')

    expect(moveAcrossVisible(view, 1)).toBe(true)

    expect(view.state.selection.$head.parent.textContent).toBe('b ^bbb222')
    expect(view.state.selection.$head.parentOffset).toBe(0)

    expect(moveAcrossVisible(view, -1)).toBe(true)
    expect(view.state.selection.$head.parent.textContent).toBe('a ^aaa111')
    expect(view.state.selection.head).toBe(anchorVisibleEnd(view.state.selection.$head))
  })

  it('hands off to the host past the first and the last visible block', () => {
    const { view, events } = mount(doc(), target(['aaa111', 'bbb222']))
    caretIn(view, 'a', 'start')
    moveAcrossVisible(view, -1)
    caretIn(view, 'b', 'end')
    moveAcrossVisible(view, 1)

    expect(events).toEqual([
      { type: PORTAL_EXIT_EVENT, detail: { direction: 'before' } },
      { type: PORTAL_EXIT_EVENT, detail: { direction: 'after' } }
    ])
  })
})

describe('pruning the fence after a deletion', () => {
  const doc = (): PartialBlock[] => [
    para('Root ^root11', [para('kid ^kid111'), para('other ^oth111')]),
    para('Second ^sec111'),
    para('tail')
  ]
  const spec = target(['root11', 'sec111'], { root11: { mode: 'show', ids: ['kid111', 'oth111'] } })

  /** Delete the block whose text is `text`, tagging the transaction like y-prosemirror would. */
  function deleteBlock(view: View, text: string, meta?: Record<string, boolean>): void {
    let range: [number, number] | null = null
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'blockContainer' && node.firstChild?.textContent === text) {
        range = [pos, pos + node.nodeSize]
      }
    })
    const tr = view.state.tr.delete(range![0], range![1])
    if (meta) tr.setMeta(ySyncPluginKey, meta)
    view.dispatch(tr)
  }

  const written = (plans: PortalPlan[]) => plans.map((p) => p.definition.target)

  it('drops the anchor of a block a local edit deleted', () => {
    const { view, plans } = mount(doc(), spec)
    deleteBlock(view, 'kid ^kid111')

    expect(written(plans)).toEqual([
      expect.objectContaining({
        open: { root11: { mode: 'show', ids: ['oth111'] } }
      })
    ])
  })

  it('also prunes on this window own undo or redo, which y-prosemirror tags as a change origin', () => {
    const { view, plans } = mount(doc(), spec)
    deleteBlock(view, 'Second ^sec111', { isChangeOrigin: true, isUndoRedoOperation: true })

    expect(written(plans)).toEqual([expect.objectContaining({ blocks: ['root11'] })])
  })

  it('prunes nothing on a remote update, or when the source has not hydrated', () => {
    const { view, plans } = mount(doc(), spec)
    deleteBlock(view, 'Second ^sec111', { isChangeOrigin: true })
    deleteBlock(view, 'kid ^kid111', { isChangeOrigin: true })

    expect(plans).toEqual([])

    const hydrating = mount([para('')], spec)
    hydrating.view.dispatch(hydrating.view.state.tr.insertText('typed'))
    expect(hydrating.plans).toEqual([])
  })
})
