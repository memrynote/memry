import { afterEach, describe, expect, it } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'

// Regression guard for the `Cannot read properties of undefined (reading 'id')`
// window_error seen in production (2026.811.1 darwin, 2026.817.1 win32).
//
// Located by reading the shipped renderer bundle: the single reported frame,
// `HTMLDivElement.<anonymous>` at index-BWaMlYGi.js:175892:60, is
// @blocknote/core's TableHandlesView.mouseMoveHandler, bound with
// `pmView.dom.addEventListener("mousemove", ...)` — hence a bare div listener as
// the only stack frame, and hence a burst of identical throws while the pointer
// keeps moving.
//
// The throw is a two-step. TableHandlesView.update() does:
//
//   this.state.block = this.editor.getBlock(this.state.block.id)!
//
// The non-null assertion is a lie: getBlock() returns undefined once the hovered
// table is gone, so `undefined` is written into state.block. update() then hides
// the handles but keeps the state object. mouseMoveHandler later reads
// `this.state?.block.id` — optional chaining guards state, NOT state.block — and
// throws on the next pointer move.
//
// Fixed as a pnpm patch (patches/@blocknote__core@0.47.1.patch): update() only
// assigns state.block when the lookup succeeded, so the last known block stays
// readable and the hide path is unchanged. Same vehicle as the getParentBlockInfo
// depth guard already carried in that patch.
//
// Uses the default BlockNote schema — the custom schema's extra block specs drag
// react-pdf into jsdom and are irrelevant to table handles.

const mounted: Array<{ editor: BlockNoteEditor; el: HTMLElement }> = []

afterEach(() => {
  for (const { editor, el } of mounted.splice(0)) {
    editor.unmount()
    el.remove()
  }
})

const table = (label: string) => ({
  type: 'table' as const,
  content: {
    type: 'tableContent' as const,
    rows: [{ cells: [[`${label}1`], [`${label}2`]] }, { cells: [[`${label}3`], [`${label}4`]] }]
  }
})

function mountEditorWithTwoTables(): BlockNoteEditor {
  const editor = BlockNoteEditor.create()
  const el = document.createElement('div')
  document.body.appendChild(el)
  editor.mount(el)
  mounted.push({ editor, el })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editor.replaceBlocks(editor.document, [table('a'), table('b')] as any)
  return editor
}

// The TableHandlesView instance the real plugin created. It is not exported from
// @blocknote/core, so it is reached where ProseMirror keeps it: the live plugin
// view list on the mounted EditorView. Duck-typed rather than instanceof'd for
// the same reason.
interface TableHandlesViewLike {
  state?: { show: boolean; block?: { id: string } }
  mouseMoveHandler: (event: MouseEvent) => unknown
  update: () => void
}

function getTableHandlesView(editor: BlockNoteEditor): TableHandlesViewLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pmView = (editor as any)._tiptapEditor.view
  const views = (pmView.pluginViews ?? []) as TableHandlesViewLike[]
  const found = views.find(
    (view) => typeof view?.mouseMoveHandler === 'function' && typeof view?.update === 'function'
  )
  expect(found, 'TableHandlesView not found on the mounted editor').toBeDefined()
  return found as TableHandlesViewLike
}

// Hovering a table is what populates TableHandlesView.state. jsdom reports every
// rect as 0x0, but mouseMoveHandler only compares rects for the extend-buttons
// flags — the branch that sets state.block is driven by the DOM hit target, which
// is real here because BlockNote renders a real <table>.
function hover(view: TableHandlesViewLike, element: Element): void {
  const event = new MouseEvent('mousemove', { bubbles: true, clientX: 1, clientY: 1 })
  Object.defineProperty(event, 'target', { value: element, configurable: true })
  view.mouseMoveHandler(event)
}

function tableOf(editor: BlockNoteEditor, tableIndex: number): HTMLTableElement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const el = (editor as any)._tiptapEditor.view.dom as HTMLElement
  const node = el.querySelectorAll('table')[tableIndex]
  expect(node, `no rendered table at index ${tableIndex}`).toBeTruthy()
  return node as HTMLTableElement
}

function cellOf(editor: BlockNoteEditor, tableIndex: number): Element {
  const cell = tableOf(editor, tableIndex).querySelector('td, th')
  expect(cell, `no rendered cell for table ${tableIndex}`).toBeTruthy()
  return cell as Element
}

// The throwing read lives in the `wrapper` branch of mouseMoveHandler — the one
// taken when the pointer is over the table's wrapper rather than a cell, i.e.
// just below or to the right of the table.
function wrapperOf(editor: BlockNoteEditor, tableIndex: number): Element {
  const wrapper = tableOf(editor, tableIndex).closest('.tableWrapper')
  expect(wrapper, `no .tableWrapper for table ${tableIndex}`).toBeTruthy()
  return wrapper as Element
}

describe('table handles keep a readable block after the hovered table is removed', () => {
  it('does not write undefined into state.block when the hovered table is gone', () => {
    const editor = mountEditorWithTwoTables()
    const view = getTableHandlesView(editor)

    const [tableA, tableB] = editor.document
    expect(tableA.type).toBe('table')
    expect(tableB.type).toBe('table')

    hover(view, cellOf(editor, 0))
    expect(view.state?.block?.id).toBe(tableA.id)

    // The hovered table goes away. update() runs on the resulting transaction.
    editor.removeBlocks([tableA.id])
    view.update()

    // The production defect: state.block became undefined here, and every later
    // pointer move threw reading `.id` off it.
    expect(view.state?.block).toBeDefined()
    expect(view.state?.block?.id).toBe(tableA.id)
    expect(view.state?.show).toBe(false)
  })

  it('survives moving the pointer onto another table afterwards', () => {
    const editor = mountEditorWithTwoTables()
    const view = getTableHandlesView(editor)

    const [tableA, tableB] = editor.document
    hover(view, cellOf(editor, 0))
    expect(view.state?.block?.id).toBe(tableA.id)

    editor.removeBlocks([tableA.id])
    view.update()

    // This is the reported throw: HTMLDivElement.<anonymous> reading 'id' off
    // undefined, once per pointer move over what is left.
    expect(() => hover(view, wrapperOf(editor, 0))).not.toThrow()
    expect(view.state?.block?.id).toBe(tableB.id)
  })
})
