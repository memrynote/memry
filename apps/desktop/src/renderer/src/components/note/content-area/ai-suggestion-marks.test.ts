import { afterEach, describe, expect, it, vi } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'
import { AIExtension } from '@blocknote/xl-ai'
import { aiSuggestionMarksExtension } from './ai-suggestion-marks'

/**
 * #2527: Reject in the AI menu threw "Failed to find insertion mark in schema".
 * `useBlockNoteSetup` registers `AIExtension` on a live editor, and BlockNote
 * cannot add the extension's tiptap marks after creation. These go through a
 * real editor and the real xl-ai extension, registered the way the hook does.
 *
 * Default schema on purpose: the desktop schema's block specs drag react-pdf
 * into jsdom, and the marks are schema independent.
 */

const mounted: Array<{ editor: BlockNoteEditor; el: HTMLElement }> = []
const originalScrollIntoView = Element.prototype.scrollIntoView
let restoreScrollIntoView = false

afterEach(() => {
  if (restoreScrollIntoView) {
    Element.prototype.scrollIntoView = originalScrollIntoView
    restoreScrollIntoView = false
  }
  for (const { editor, el } of mounted.splice(0)) {
    editor.unmount()
    el.remove()
  }
  vi.restoreAllMocks()
})

function mount(options: Partial<Parameters<typeof BlockNoteEditor.create>[0]>): BlockNoteEditor {
  const editor = BlockNoteEditor.create(options)
  const el = document.createElement('div')
  document.body.appendChild(el)
  editor.mount(el)
  mounted.push({ editor, el })
  return editor
}

function registerAI(editor: BlockNoteEditor): NonNullable<ReturnType<typeof getAI>> {
  editor.registerExtension(AIExtension())
  const ai = getAI(editor)
  if (!ai) throw new Error('AI extension did not register')
  return ai
}

function getAI(editor: BlockNoteEditor) {
  return editor.getExtension(AIExtension)
}

describe('aiSuggestionMarksExtension', () => {
  it('reproduces #2527 without it: AI registered late has no insertion mark and reject throws', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const editor = mount({})
    const ai = registerAI(editor)

    expect(editor.pmSchema.marks.insertion).toBeUndefined()
    expect(() => ai.rejectChanges()).toThrow(/Failed to find insertion mark in schema/)
  })

  it('puts the insertion, deletion and modification marks in the schema at creation', () => {
    const editor = mount({ extensions: [aiSuggestionMarksExtension] })

    expect(editor.pmSchema.marks.insertion).toBeDefined()
    expect(editor.pmSchema.marks.deletion).toBeDefined()
    expect(editor.pmSchema.marks.modification).toBeDefined()
  })

  it('lets the late-registered AI extension reject and accept a suggested insertion', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // jsdom has no layout; `openAIMenuAtBlock` scrolls the block into view.
    Element.prototype.scrollIntoView = vi.fn()
    restoreScrollIntoView = true
    const editor = mount({ extensions: [aiSuggestionMarksExtension] })
    editor.replaceBlocks(editor.document, [{ type: 'paragraph', content: 'kaan' }])
    const ai = registerAI(editor)
    const suggestInsertion = (): void => {
      ai.openAIMenuAtBlock(editor.document[0].id)
      editor.exec((state, dispatch) => {
        let insertAt = 0
        state.doc.descendants((node, pos) => {
          if (node.isText && node.text === 'kaan') insertAt = pos + node.nodeSize
        })
        dispatch?.(
          state.tr
            .insertText(' was here', insertAt)
            .addMark(
              insertAt,
              insertAt + ' was here'.length,
              state.schema.marks.insertion.create({ id: 1 })
            )
        )
        return true
      })
    }
    const text = (): unknown => editor.document[0].content

    suggestInsertion()
    expect(() => ai.rejectChanges()).not.toThrow()
    expect(text()).toEqual([{ type: 'text', text: 'kaan', styles: {} }])
    expect(ai.store.state.aiMenuState).toBe('closed')
    expect(editor.isEditable).toBe(true)

    suggestInsertion()
    expect(() => ai.acceptChanges()).not.toThrow()
    expect(text()).toEqual([{ type: 'text', text: 'kaan was here', styles: {} }])
    let leftoverMarks = 0
    editor.prosemirrorState.doc.descendants((node) => {
      if (node.marks.some((mark) => mark.type.name === 'insertion')) leftoverMarks++
    })
    expect(leftoverMarks).toBe(0)
  })

  it('keeps the marks when AI is turned off and on again', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const editor = mount({ extensions: [aiSuggestionMarksExtension] })
    registerAI(editor)
    editor.unregisterExtension('ai')

    const ai = registerAI(editor)

    expect(editor.pmSchema.marks.insertion).toBeDefined()
    expect(() => ai.rejectChanges()).not.toThrow()
  })
})
