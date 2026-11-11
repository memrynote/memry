/**
 * Typing an editor refuses during an outside edit's hold is not lost when the note closes, or the
 * window or the app goes, before the edit's frame arrives (#4252): the note's binding stays until
 * the frame applies, the typing goes in over the edit, and only then does the note close. A real
 * BlockNote editor on the document `useYjsCollaboration` binds, against a fake editor host behind
 * the `crdt_*` commands that keeps one Y.Doc per note, as `commands/editor.rs` does.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import * as Y from 'yjs'
import { BlockNoteEditor } from '@blocknote/core'
import { TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

interface TestChannel {
  onmessage: (data: ArrayBuffer) => void
}

const host = vi.hoisted(() => ({
  docs: new Map<string, unknown>(),
  channels: new Map<string, TestChannel>(),
  /** What reached the host, in order: `open <note>`, `apply <note>` (an edit), `close <note>`. */
  calls: [] as string[]
}))

vi.mock('@tauri-apps/api/core', async () => {
  const Yjs = await import('yjs')
  const docOf = (noteId: string): Y.Doc => {
    let doc = host.docs.get(noteId) as Y.Doc | undefined
    if (!doc) {
      doc = new Yjs.Doc()
      host.docs.set(noteId, doc)
    }
    return doc
  }
  return {
    Channel: class {
      constructor(public onmessage: (data: ArrayBuffer) => void = () => {}) {}
    },
    invoke: vi.fn(async (command: string, args: unknown, options?: { headers: never }) => {
      if (command === 'crdt_open_doc') {
        const { noteId, onUpdate } = args as { noteId: string; onUpdate: TestChannel }
        host.channels.set(noteId, onUpdate)
        host.calls.push(`open ${noteId}`)
        const doc = docOf(noteId)
        const state = Yjs.encodeStateAsUpdate(doc)
        const vector = Yjs.encodeStateVector(doc)
        const json = new TextEncoder().encode(
          JSON.stringify({ needsSeed: false, stateLength: state.length, readOnly: null })
        )
        const bytes = new Uint8Array(4 + json.length + state.length + vector.length)
        new DataView(bytes.buffer).setUint32(0, json.length, false)
        bytes.set(json, 4)
        bytes.set(state, 4 + json.length)
        bytes.set(vector, 4 + json.length + state.length)
        return bytes.buffer
      }
      const { noteId } = JSON.parse(options?.headers['x-memry-meta'] ?? '{}') as { noteId: string }
      Yjs.applyUpdate(docOf(noteId), args as Uint8Array, 'window')
      if (command === 'crdt_apply_update') host.calls.push(`apply ${noteId}`)
      return new ArrayBuffer(0)
    })
  }
})

vi.mock('../../../../../generated/bindings', () => ({
  commands: {
    crdtCloseDoc: async (noteId: string) => {
      host.calls.push(`close ${noteId}`)
      return null
    },
    crdtTypingSent: async () => null,
    vaultLocksList: async () => ({ notes: [], folders: [] })
  },
  events: {
    crdtProviderResetEvent: { listen: async () => () => {} },
    crdtProviderReadyEvent: { listen: async () => () => {} },
    vaultLocksChangedEvent: { listen: async () => () => {} }
  }
}))

vi.mock('@/lib/logger', () => {
  const quiet = () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
    log: vi.fn()
  })
  return { log: quiet(), createLogger: quiet }
})
vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))
vi.mock('@/lib/url-metadata', () => ({
  fetchLinkPreview: vi.fn().mockResolvedValue({ domain: '', title: '', favicon: '' })
}))

import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { flushAllPendingSaves } from '@/lib/save-registry'
import { typingHoldOf } from '@/sync/typing-hold'
import { useYjsCollaboration } from '@/sync/use-yjs-collaboration'
import { withCollaborationIfLive } from './collaboration-options'
import { editorSchema } from './editor-schema'
import { mountTestEditor, para, unmountTestEditors } from './portal/portal-test-editor'
import { registerEditorPlugin } from './register-editor-plugin'
import { createTypingHoldPlugin } from './typing-hold-plugin'

const BARRIER_FRAME = 5
const EXTERNAL_ORIGIN = 2

const editors: BlockNoteEditor[] = []

/** The host's document of `noteId`, holding the paragraphs `texts`. */
function storeNote(noteId: string, texts: string[]): void {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(mountTestEditor(texts.map((text) => para(text))).doc))
  host.docs.set(noteId, doc)
}

beforeEach(() => {
  host.docs.clear()
  host.channels.clear()
  host.calls = []
  storeNote('note-1', ['Alpha line.', 'Bravo line.'])
  storeNote('note-2', ['Other note.'])
})

afterEach(() => {
  for (const editor of editors.splice(0)) editor.unmount()
  unmountTestEditors()
})

/** Opens `note-1` as ContentArea does: the collaboration hook, and an editor on its fragment. */
async function openNote() {
  const hook = renderHook((props) => useYjsCollaboration(props), {
    initialProps: { noteId: 'note-1' }
  })
  await waitFor(() => expect(hook.result.current.isReady).toBe(true))
  const { doc, fragment } = hook.result.current
  if (!doc || !fragment) throw new Error('the note did not bind')
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- the tests drive the app schema through the default BlockNoteEditor surface; the two schema generics do not unify
  const editor = BlockNoteEditor.create(
    withCollaborationIfLive(fragment, { schema: editorSchema })
  ) as unknown as BlockNoteEditor
  const el = document.createElement('div')
  document.body.appendChild(el)
  editor.mount(el)
  editors.push(editor)
  registerEditorPlugin(editor, createTypingHoldPlugin(typingHoldOf(doc)))
  return { hook, doc, editor, view: editor._tiptapEditor.view }
}

/** The host asks for the window's typing before it applies an outside edit; the window holds. */
async function holdTyping(doc: Y.Doc, barrier = 1): Promise<void> {
  const bytes = new Uint8Array(5)
  bytes[0] = BARRIER_FRAME
  new DataView(bytes.buffer).setUint32(1, barrier, true)
  host.channels.get('note-1')?.onmessage(bytes.buffer)
  await waitFor(() => expect(typingHoldOf(doc).held).toBe(true))
}

/** Keystrokes at the end of `text`'s block, which the hold refuses. */
function typeAfter(view: EditorView, text: string, keys: string[]): void {
  let at = -1
  view.state.doc.descendants((node, pos) => {
    if (at === -1 && node.isTextblock && node.textContent === text) at = pos + 1 + text.length
    return at === -1
  })
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)))
  for (const key of keys) view.dispatch(view.state.tr.insertText(key))
}

/** The outside edit as the core applies and sends it: the whole body replaced by the file's. */
function applyOutsideEdit(texts: string[]): void {
  const stored = host.docs.get('note-1') as Y.Doc
  const before = Y.encodeStateVector(stored)
  const file = mountTestEditor(texts.map((text) => para(text))).doc.getXmlFragment(
    CRDT_FRAGMENT_NAME
  )
  const body = stored.getXmlFragment(CRDT_FRAGMENT_NAME)
  stored.transact(() => {
    body.delete(0, body.length)
    body.insert(
      0,
      file.toArray().map((node) => node.clone())
    )
  })
  const update = Y.encodeStateAsUpdate(stored, before)
  const bytes = new Uint8Array(update.length + 1)
  bytes[0] = EXTERNAL_ORIGIN
  bytes.set(update, 1)
  host.channels.get('note-1')?.onmessage(bytes.buffer)
}

/** The paragraphs of `noteId` as the host stores them. */
function storedTexts(noteId: string): string[] {
  const texts: string[] = []
  const walk = (node: Y.XmlElement | Y.XmlFragment): void => {
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlText) texts.push(child.toString())
      else if (child instanceof Y.XmlElement) walk(child)
    }
  }
  walk((host.docs.get(noteId) as Y.Doc).getXmlFragment(CRDT_FRAGMENT_NAME))
  return texts
}

describe('typing held when its note closes', () => {
  it('goes in over the outside edit when the note unmounts mid-hold, before the note closes', async () => {
    const { hook, doc, editor, view } = await openNote()
    await holdTyping(doc)
    typeAfter(view, 'Alpha line.', [' ', 'n', 'e', 'w'])

    act(() => {
      editor.unmount()
      hook.unmount()
    })
    await act(async () => {})
    expect(host.calls).not.toContain('close note-1')

    applyOutsideEdit(['Alpha line.', 'Bravo line.', 'Added by an agent.'])
    await waitFor(() => expect(host.calls).toContain('close note-1'))
    expect(storedTexts('note-1')).toEqual(['Alpha line. new', 'Bravo line.', 'Added by an agent.'])
    expect(host.calls.slice(-2)).toEqual(['apply note-1', 'close note-1'])
  })

  it('goes in over the outside edit when another note opens in its place mid-hold', async () => {
    const { hook, doc, editor, view } = await openNote()
    await holdTyping(doc)
    typeAfter(view, 'Bravo line.', ['!'])

    act(() => {
      editor.unmount()
      hook.rerender({ noteId: 'note-2' })
    })
    // The other note does not wait for the held one.
    await waitFor(() => expect(hook.result.current.provider?.noteId).toBe('note-2'))
    expect(hook.result.current.isReady).toBe(true)
    expect(host.calls).not.toContain('close note-1')

    applyOutsideEdit(['Alpha line. EXT', 'Bravo line.'])
    await waitFor(() => expect(host.calls).toContain('close note-1'))
    expect(storedTexts('note-1')).toEqual(['Alpha line. EXT', 'Bravo line.!'])
  })

  it('is in the note when it opens again before the edit arrived', async () => {
    const { hook, doc, editor, view } = await openNote()
    await holdTyping(doc)
    typeAfter(view, 'Alpha line.', ['x'])
    act(() => {
      editor.unmount()
      hook.unmount()
    })
    await act(async () => {})
    const again = renderHook(() => useYjsCollaboration({ noteId: 'note-1' }))
    await act(async () => {})
    expect(again.result.current.isReady).toBe(false)

    applyOutsideEdit(['Alpha line.', 'Bravo line. EXT'])
    await waitFor(() => expect(again.result.current.isReady).toBe(true))
    expect(host.calls.filter((call) => call.endsWith('note-1'))).toEqual([
      'open note-1',
      'apply note-1',
      'close note-1',
      'open note-1'
    ])
    expect(again.result.current.fragment?.toJSON()).toContain('Alpha line.x')
    again.unmount()
  })

  it('is flushed over the edit by a quit or a window close, whose flush waits for the hold', async () => {
    const { doc, view } = await openNote()
    await holdTyping(doc)
    typeAfter(view, 'Alpha line.', ['!'])

    let flushed = false
    const flushing = flushAllPendingSaves().then(() => (flushed = true))
    await act(async () => {})
    expect(flushed).toBe(false)

    applyOutsideEdit(['Alpha line.', 'Bravo line.', 'Added by an agent.'])
    await flushing
    expect(storedTexts('note-1')).toEqual(['Alpha line.!', 'Bravo line.', 'Added by an agent.'])
  })
})
