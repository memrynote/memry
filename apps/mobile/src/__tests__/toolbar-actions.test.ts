import { describe, expect, it, vi } from 'vitest'

import {
  GuestMsgSchema,
  HostMsgSchema,
  ToolbarActionSchema,
  type EditorToolbarSelection,
  type ToolbarAction
} from '@memry/contracts/webview-bridge'

import {
  dispatchToolbarAction,
  type EditorToolbarActions
} from '../../editor-web/src/toolbar-actions'

/**
 * The native toolbar reaches the document through `toolbar-action`, and the
 * document reaches the toolbar through `toolbar-selection`. Both are checked
 * at the bridge: a press that parses but lands nowhere is a dead button, and
 * a selection the schema rejects is a toolbar that never updates.
 */

function actions(): EditorToolbarActions {
  return {
    insert: vi.fn(),
    tableAction: vi.fn(),
    styleAction: vi.fn(),
    turnInto: vi.fn(),
    toggleStyle: vi.fn(),
    toggleBulletedList: vi.fn(),
    createLink: vi.fn(),
    focusEditor: vi.fn(),
    insertWikiLink: vi.fn(),
    insertImage: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    dismissKeyboard: vi.fn(),
    openBlockActions: vi.fn()
  }
}

/** Every action the toolbar can send, with the method and arguments it must reach. */
const MATRIX: { action: ToolbarAction; method: keyof EditorToolbarActions; args: unknown[] }[] = [
  { action: { kind: 'toggle-style', style: 'bold' }, method: 'toggleStyle', args: ['bold'] },
  {
    action: { kind: 'turn-into', block: { kind: 'heading', level: 2 } },
    method: 'turnInto',
    args: [{ kind: 'heading', level: 2 }]
  },
  {
    action: { kind: 'insert', action: { kind: 'attachment', blockType: 'file' } },
    method: 'insert',
    args: [{ kind: 'attachment', blockType: 'file' }]
  },
  {
    action: {
      kind: 'table',
      action: { kind: 'structure', op: { kind: 'move-column', direction: 'end' } }
    },
    method: 'tableAction',
    args: [{ kind: 'structure', op: { kind: 'move-column', direction: 'end' } }]
  },
  {
    action: { kind: 'style', action: { kind: 'background-colour', colour: 'yellow' } },
    method: 'styleAction',
    args: [{ kind: 'background-colour', colour: 'yellow' }]
  },
  { action: { kind: 'toggle-bulleted-list' }, method: 'toggleBulletedList', args: [] },
  {
    action: { kind: 'create-link', url: 'https://memry.app' },
    method: 'createLink',
    args: ['https://memry.app']
  },
  { action: { kind: 'focus' }, method: 'focusEditor', args: [] },
  { action: { kind: 'insert-wiki-link' }, method: 'insertWikiLink', args: [] },
  { action: { kind: 'insert-image' }, method: 'insertImage', args: [] },
  { action: { kind: 'undo' }, method: 'undo', args: [] },
  { action: { kind: 'redo' }, method: 'redo', args: [] },
  { action: { kind: 'blur' }, method: 'dismissKeyboard', args: [] },
  { action: { kind: 'open-block-actions' }, method: 'openBlockActions', args: [] }
]

describe('toolbar-action dispatch', () => {
  it('covers every action kind the contract can carry', () => {
    const kinds = new Set(MATRIX.map((entry) => entry.action.kind))
    const shape = HostMsgSchema.safeParse({ type: 'toolbar-action', docId: 'n', action: {} })
    expect(shape.success).toBe(false)
    // The union's own option list is the source of truth for what a matrix
    // entry can miss.
    const declared = ToolbarActionSchema.options.map((option) => option.shape.kind.value)
    expect([...kinds].sort()).toEqual([...declared].sort())
  })

  it.each(MATRIX)('routes $action.kind to $method', ({ action, method, args }) => {
    const target = actions()
    const wire = HostMsgSchema.parse({ type: 'toolbar-action', docId: 'note-1', action })
    if (wire.type !== 'toolbar-action') throw new Error('wrong message')

    dispatchToolbarAction(target, wire.action)

    expect(target[method]).toHaveBeenCalledTimes(1)
    expect(target[method]).toHaveBeenCalledWith(...args)
    for (const other of Object.keys(target) as (keyof EditorToolbarActions)[]) {
      if (other !== method) expect(target[other]).not.toHaveBeenCalled()
    }
  })

  it('refuses an action for a block the guest cannot convert to', () => {
    const result = HostMsgSchema.safeParse({
      type: 'toolbar-action',
      docId: 'note-1',
      action: { kind: 'turn-into', block: { kind: 'image' } }
    })
    expect(result.success).toBe(false)
  })
})

describe('toolbar-selection wire', () => {
  it('carries the whole caret state the toolbar renders from', () => {
    const selection: EditorToolbarSelection = {
      blockLabel: 'H2',
      activeStyles: { bold: true, italic: false, underline: false, strike: false, code: true },
      table: { structureLocked: true },
      alignment: 'justify',
      textColour: 'red',
      backgroundColour: 'default',
      canNest: true,
      canUnnest: false
    }
    const parsed = GuestMsgSchema.parse({ type: 'toolbar-selection', docId: 'note-1', selection })
    expect(parsed).toEqual({ type: 'toolbar-selection', docId: 'note-1', selection })
  })

  it('needs every inline style answered, so a stale guest cannot leave a button undefined', () => {
    const result = GuestMsgSchema.safeParse({
      type: 'toolbar-selection',
      docId: 'note-1',
      selection: {
        blockLabel: 'T',
        activeStyles: { bold: true },
        table: null,
        alignment: null,
        textColour: 'default',
        backgroundColour: 'default',
        canNest: false,
        canUnnest: false
      }
    })
    expect(result.success).toBe(false)
  })

  it('reports editor focus as its own addressed message', () => {
    expect(GuestMsgSchema.parse({ type: 'editor-focus', docId: 'note-1', focused: true })).toEqual({
      type: 'editor-focus',
      docId: 'note-1',
      focused: true
    })
  })
})
