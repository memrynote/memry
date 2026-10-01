/**
 * The writing tools session against a REAL collaborative editor: a mounted
 * `BlockNoteEditor` on the real `editorSchema`, bound to a real `Y.Doc`
 * through the production collaboration helper. Anchors are Y relative
 * positions, so only a live y-prosemirror binding can show that they resolve,
 * follow edits, and re-anchor after an in-place swap.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'
import type { EditorView } from '@tiptap/pm/view'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { TextSelection } from '@tiptap/pm/state'
import { yUndoPluginKey } from 'y-prosemirror'
import {
  readWritingAlternativesFromYDoc,
  readWritingGhostsFromYDoc,
  readWritingOverflowFromYDoc,
  writeWritingAlternativesToYDoc
} from '@memry/shared'
import type { WritingAssistResult } from '@memry/contracts/writing-tools-api'

vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))

vi.mock('@/lib/url-metadata', () => ({
  fetchLinkPreview: vi.fn().mockResolvedValue({ domain: '', title: '', favicon: '' })
}))

import { editorSchema } from '../content-area/editor-schema'
import { withCollaborationIfLive } from '../content-area/collaboration-options'
import { WritingToolsSession, type GenerateWritingAssist } from './writing-tools-session'
import { collectTextBlocks, writingToolsPluginKey } from './writing-tools-plugin'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function setup(text: string, generateAssist: GenerateWritingAssist = vi.fn()) {
  const doc = new Y.Doc()
  const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
  const editor = BlockNoteEditor.create(
    withCollaborationIfLive(fragment, { schema: editorSchema })
  ) as unknown as BlockNoteEditor
  const el = document.createElement('div')
  document.body.appendChild(el)
  editor.mount(el)
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: [{ type: 'text', text, styles: {} }] } as never
  ])

  const session = new WritingToolsSession(
    generateAssist,
    (position, total) => `${position}/${total}`,
    true
  )
  let attached = true
  const attachDetach = session.attach({ editor, doc, container: el })
  const detach = (): void => {
    if (attached) attachDetach()
    attached = false
  }
  cleanups.push(() => {
    detach()
    editor.unmount()
    el.remove()
    doc.destroy()
  })

  const view = (editor as unknown as { _tiptapEditor: { view: EditorView } })._tiptapEditor.view
  const bodyText = (): string =>
    collectTextBlocks(view.state.doc)
      .map((block) => block.text)
      .join('\n')
      .trim()
  const rangeOf = (needle: string): { from: number; to: number } => {
    for (const block of collectTextBlocks(view.state.doc)) {
      const offset = block.text.indexOf(needle)
      if (offset !== -1)
        return { from: block.from + offset, to: block.from + offset + needle.length }
    }
    throw new Error(`"${needle}" is not in the body`)
  }
  /** Where the plugin currently resolves each alternative / ghost. */
  const resolved = (kind: 'alternatives' | 'ghosts'): Array<{ from: number; to: number }> =>
    (writingToolsPluginKey.getState(view.state)?.[kind] ?? []).map(({ from, to }) => ({ from, to }))
  /** Re-resolve every anchor from the Y.Doc, as any records write does. */
  const refresh = (): void => {
    session.addOverflow(`refresh ${Math.random()}`)
  }
  return { doc, editor, view, session, bodyText, rangeOf, resolved, refresh, detach }
}

/** Add an alternative over `needle` with one user variant; returns its record. */
function addAlternative(ctx: ReturnType<typeof setup>, needle: string, variant: string) {
  const range = ctx.rangeOf(needle)
  ctx.session.startAlternative(range.from, range.to)
  ctx.session.submitDraft(variant)
  return readWritingAlternativesFromYDoc(ctx.doc)[0]
}

function pressArrowDown(target: EventTarget): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

describe('WritingToolsSession (live Y.Doc binding)', () => {
  it('stores an alternative and swaps the body text in place, fixing "a"/"an"', () => {
    const { doc, session, bodyText, rangeOf } = setup('It was a great idea today.')
    const range = rangeOf('great idea')

    expect(session.startAlternative(range.from, range.to)).toBe(true)
    session.submitDraft('awful idea')

    const [record] = readWritingAlternativesFromYDoc(doc)
    expect(record).toMatchObject({ original: 'great idea', activeVariantId: null })
    expect(record.variants.map((variant) => variant.text)).toEqual(['awful idea'])
    expect(session.getSnapshot().alternatives.map((alt) => alt.id)).toEqual([record.id])

    session.activateVariant(record.id, record.variants[0].id)
    expect(bodyText()).toBe('It was an awful idea today.')
    expect(readWritingAlternativesFromYDoc(doc)[0].activeVariantId).toBe(record.variants[0].id)

    // Re-anchored on the new text: cycling forward wraps back to the original.
    expect(session.cycleAlternative(record.id, 1)).toBe(true)
    expect(bodyText()).toBe('It was a great idea today.')
    expect(readWritingAlternativesFromYDoc(doc)[0].activeVariantId).toBeNull()
  })

  it('keeps an anchored range on its text while the body is edited around it', () => {
    const { doc, view, session, rangeOf } = setup('Keep this phrase here.')
    const range = rangeOf('this phrase')
    session.startAlternative(range.from, range.to)
    session.submitDraft('that phrase')
    const id = readWritingAlternativesFromYDoc(doc)[0].id

    view.dispatch(view.state.tr.insertText('Please ', rangeOf('Keep').from))
    // A refresh re-resolves every anchor from the Y.Doc.
    session.addOverflow('force a records refresh')

    expect(session.alternativeAt(rangeOf('this phrase').from + 1)).toBe(id)
    expect(session.alternativeAt(rangeOf('Please').from)).toBeNull()
  })

  it('drops the record when its last variant is removed and restores the original', () => {
    const { doc, session, bodyText, rangeOf } = setup('One small step.')
    const range = rangeOf('small')
    session.startAlternative(range.from, range.to)
    session.submitDraft('giant')
    const record = readWritingAlternativesFromYDoc(doc)[0]
    session.activateVariant(record.id, record.variants[0].id)
    expect(bodyText()).toBe('One giant step.')

    session.removeVariant(record.id, record.variants[0].id)

    expect(bodyText()).toBe('One small step.')
    expect(readWritingAlternativesFromYDoc(doc)).toEqual([])
  })

  it('leaves ghosted words out of the word count and counts them again once revived', async () => {
    const { session, rangeOf } = setup('alpha beta gamma delta')
    session.setWordCountEnabled(true)
    const nextFrame = (): Promise<void> =>
      new Promise((resolve) => requestAnimationFrame(() => resolve()))

    await nextFrame()
    expect(session.getSnapshot().wordCount).toBe(4)

    const range = rangeOf('beta gamma')
    expect(session.ghost(range.from, range.to)).toBe(true)
    await nextFrame()
    expect(session.getSnapshot().wordCount).toBe(2)

    const ghostId = session.ghostAt(range.from + 1)
    expect(ghostId).not.toBeNull()
    session.revive(ghostId as string)
    await nextFrame()
    expect(session.getSnapshot().wordCount).toBe(4)
  })

  it('stashes the selection into the overflow list and out of the body', () => {
    const { doc, session, bodyText, rangeOf } = setup('Keep this. Move that.')
    const range = rangeOf(' Move that.')

    expect(session.stash(range.from, range.to)).toBe(true)

    expect(bodyText()).toBe('Keep this.')
    expect(readWritingOverflowFromYDoc(doc).map((item) => item.text)).toEqual(['Move that.'])
  })

  it('cuts accepted trim suggestions and keeps the rest of the text', async () => {
    const generateAssist = vi.fn<GenerateWritingAssist>().mockResolvedValue({
      kind: 'trim',
      cuts: [{ quote: ' really' }, { quote: 'not in the note' }, { quote: ' very' }]
    })
    const { session, bodyText } = setup('It is really a very good plan.', generateAssist)

    expect(await session.runTrim('tighten')).toBe(2)
    expect(session.getSnapshot().lab.trim).toMatchObject({ level: 'tighten', focusedIndex: 0 })

    session.keepTrim()
    expect(session.getSnapshot().lab.trim?.ids).toHaveLength(1)
    session.cutTrim()

    expect(bodyText()).toBe('It is really a good plan.')
    expect(session.getSnapshot().lab.trim).toBeNull()
  })

  it('drops an alternative whose text was deleted instead of moving it onto the next character', () => {
    const ctx = setup('One small step.')
    addAlternative(ctx, 'small', 'giant')
    const range = ctx.rangeOf('small')

    ctx.view.dispatch(ctx.view.state.tr.delete(range.from, range.to))
    ctx.refresh()

    expect(ctx.resolved('alternatives')).toEqual([])
    expect(ctx.session.getSnapshot().alternatives).toEqual([])
  })

  it('shrinks an anchored range when its last or first character is deleted', () => {
    const ctx = setup('One small step.')
    addAlternative(ctx, 'small', 'giant')
    const range = ctx.rangeOf('small')

    ctx.view.dispatch(ctx.view.state.tr.delete(range.to - 1, range.to))
    ctx.refresh()
    expect(ctx.resolved('alternatives')).toEqual([ctx.rangeOf('smal')])

    const shrunk = ctx.rangeOf('smal')
    ctx.view.dispatch(ctx.view.state.tr.delete(shrunk.from, shrunk.from + 1))
    ctx.refresh()
    expect(ctx.resolved('alternatives')).toEqual([ctx.rangeOf('mal')])
  })

  it('drops a ghost whose text was deleted', () => {
    const ctx = setup('alpha beta gamma')
    const range = ctx.rangeOf('beta')
    ctx.session.ghost(range.from, range.to)

    ctx.view.dispatch(ctx.view.state.tr.delete(range.from, range.to))
    ctx.refresh()

    expect(readWritingGhostsFromYDoc(ctx.doc)).toHaveLength(1)
    expect(ctx.resolved('ghosts')).toEqual([])
  })

  it('lands back on the original text when a variant swap is undone', () => {
    const ctx = setup('It was a great idea today.')
    const record = addAlternative(ctx, 'great idea', 'awful idea')
    const undoManager = (
      yUndoPluginKey.getState(ctx.view.state) as { undoManager: Y.UndoManager } | undefined
    )?.undoManager
    undoManager?.stopCapturing()

    ctx.session.activateVariant(record.id, record.variants[0].id)
    expect(ctx.bodyText()).toBe('It was an awful idea today.')
    ctx.editor.undo()

    expect(ctx.bodyText()).toBe('It was a great idea today.')
    expect(ctx.resolved('alternatives')).toEqual([ctx.rangeOf('great idea')])
  })

  it('falls back to text only when that text occurs exactly once', () => {
    const lostAnchor = { item: { client: 987654, clock: 0 }, assoc: 0 }
    const lost = {
      id: 'alt-lost',
      anchorStart: lostAnchor,
      anchorEnd: { ...lostAnchor, assoc: -1 },
      original: 'cat',
      variants: [{ id: 'v', text: 'dog', source: 'user' as const, createdAt: 1 }],
      activeVariantId: null
    }

    const repeated = setup('The cat met another cat.')
    writeWritingAlternativesToYDoc(repeated.doc, [lost])
    expect(repeated.resolved('alternatives')).toEqual([])

    const unique = setup('The cat sat.')
    writeWritingAlternativesToYDoc(unique.doc, [lost])
    expect(unique.resolved('alternatives')).toEqual([unique.rangeOf('cat')])
  })

  it('cycles on ↓ only when the caret is in the hovered alternative and no menu owns the keys', () => {
    const ctx = setup('Start here. One small step.')
    const record = addAlternative(ctx, 'small', 'giant')
    ctx.session.hoverAlternative(record.id)

    // Caret elsewhere in the editor: ↓ stays caret movement.
    const start = ctx.rangeOf('Start').from
    ctx.view.dispatch(
      ctx.view.state.tr.setSelection(TextSelection.create(ctx.view.state.doc, start))
    )
    expect(pressArrowDown(ctx.view.dom).defaultPrevented).toBe(false)
    expect(ctx.bodyText()).toBe('Start here. One small step.')

    // Caret inside the range, but a suggestion menu is open: the menu keeps ↓.
    const inside = ctx.rangeOf('small').from + 2
    ctx.view.dispatch(
      ctx.view.state.tr.setSelection(TextSelection.create(ctx.view.state.doc, inside))
    )
    const menu = document.createElement('div')
    menu.className = 'bn-suggestion-menu'
    document.body.appendChild(menu)
    expect(pressArrowDown(ctx.view.dom).defaultPrevented).toBe(false)
    menu.remove()

    // Caret inside, nothing else open: ↓ shows the next variant.
    expect(pressArrowDown(ctx.view.dom).defaultPrevented).toBe(true)
    expect(ctx.bodyText()).toBe('Start here. One giant step.')

    // Focus in some other control: left alone.
    const button = document.createElement('button')
    document.body.appendChild(button)
    expect(pressArrowDown(button).defaultPrevented).toBe(false)
    button.remove()
  })

  it('drops alternatives the model returns after the editor left the doc', async () => {
    let answer: (result: WritingAssistResult) => void = () => {}
    const generateAssist = vi.fn<GenerateWritingAssist>(
      () => new Promise((resolve) => (answer = resolve))
    )
    const ctx = setup('One small step.', generateAssist)
    const range = ctx.rangeOf('small')

    const pending = ctx.session.suggestAlternatives(range.from, range.to)
    ctx.detach()
    answer({ kind: 'alternatives', alternatives: ['giant'] })

    expect(await pending).toBe(0)
    expect(readWritingAlternativesFromYDoc(ctx.doc)).toEqual([])
  })

  it('refuses to stash a selection holding a non-text leaf', () => {
    const ctx = setup('one\ntwo')
    const blocks = collectTextBlocks(ctx.view.state.doc).filter((block) => block.text)
    const from = blocks[0].from
    const to = from + blocks[0].text.length

    expect(ctx.session.stash(from, to)).toBe(false)
    expect(ctx.bodyText()).toContain('two')
    expect(readWritingOverflowFromYDoc(ctx.doc)).toEqual([])
  })
})
