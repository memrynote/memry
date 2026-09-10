// FIRST, deliberately: this module's body takes the `importsStart` mark, and ES
// modules evaluate in source order, so anything above it is bundle-eval time
// the trace can no longer see.
import { beginOpenMarks, guestMarks, markGuest } from './open-marks.ts'
import * as Y from 'yjs'
import { BlockNoteEditor } from '@blocknote/core'
import { codeBlockOptions } from '@blocknote/code-block'
import {
  createInlineCheckboxContent,
  createInlineImageContent,
  createWikiLinkInlineContent,
  wikiLinkConfig,
  wikiLinkToText
} from '@memry/editor-schema/inline'
import { BRIDGE_FRAGMENT_NAME, type BridgeExecCommand } from '@memry/contracts/webview-bridge'
import { assertNoWebStorage, createGuestBridge, type GuestBridge } from './bridge.ts'
import { bindAssetBridge } from './assets.ts'
import { TextSelection } from 'prosemirror-state'
import { installExternalLinks } from './external-links.ts'
import { installImageResolver } from './images.ts'
import { isForMountedDoc } from './routing.ts'
import { createMobileEditorSchema } from './schema.ts'
import {
  installWikiLinkAutocomplete,
  installWikiLinkNavigation,
  type WikiLinkAutocomplete
} from './wiki-links.ts'
import { installVisibleViewportInset } from './visual-viewport.ts'
import { installFindInNote, type FindInNoteController } from './find-in-note.ts'
import {
  installEditorToolbar,
  type ConvertibleBlock,
  type EditorToolbarController,
  type EditorToolbarSelection,
  type InlineStyle,
  type InsertBlockAction,
  type StyleAction,
  type TableAction
} from './editor-toolbar.ts'
import { readAlignment, readColour, runStyleAction } from './block-styles.ts'
import {
  applyTableStructureOp,
  handleCellPaste,
  hasMergedCells,
  readTableCursor,
  type TableContentLike,
  type TableCursor
} from './tables.ts'
import './styles.css'

/**
 * WebView editor entry (T057).
 *
 * The RN side owns the Y.Doc; this document holds a replica and persists
 * nothing. Updates the user makes here go out over the bridge and are durable
 * only once RN has written them to SQLite — which is why the local replica is
 * never treated as a source of truth, only as what the user is looking at.
 */

/** Height/selection reports are chrome hints, not edits — 200 ms is plenty. */
const METRICS_THROTTLE_MS = 200

/** Origin tag on locally-applied remote updates; stops the echo loop. */
const REMOTE_ORIGIN = Symbol('memry-remote')

markGuest('scriptEval')

const bridge = createGuestBridge()
const root = document.getElementById('root')!
const chrome = document.getElementById('editor-chrome')!

assertNoWebStorage()
bindAssetBridge(bridge)

traceHighlighter()

const schema = createMobileEditorSchema()
markGuest('schemaBuilt')
const schemaV = fingerprintSchema(schema)

/**
 * One place the editor is constructed, so the mounted-doc record can name its
 * type without restating BlockNote's generics (which the custom schema makes
 * unwriteable by hand).
 */
function createEditor(fragment: Y.XmlFragment) {
  return BlockNoteEditor.create({
    schema,
    collaboration: {
      fragment,
      // No remote cursors are ever shown here — one person, one device, one
      // doc — but the field is required, so it carries the local identity and
      // nothing else.
      user: { name: 'You', color: '#ff671a' }
    },
    trailingBlock: true,
    animations: false,
    // A cell holds inline content only, so a pasted `| a | b |` read as
    // markdown would splice a whole table over the row the caret is in (#1641).
    pasteHandler: (context) => handleCellPaste(context.editor, context),
    /*
     * The label belongs on the element that IS the text box.
     *
     * `#root` carried `role="textbox" aria-label="Note content"`, and it was
     * never reachable: BlockNote mounts its own contenteditable inside, and
     * that inner element is what VoiceOver and the iOS accessibility tree
     * expose. The wrapper's label was shadowed, so the WebView surfaced only
     * its document title and the editor had no addressable name at all.
     */
    domAttributes: {
      editor: { 'aria-label': 'Note content' }
    }
  })
}

type MobileEditor = ReturnType<typeof createEditor>

interface MountedDoc {
  docId: string
  doc: Y.Doc
  editor: MobileEditor
  toolbar: EditorToolbarController
  find: FindInNoteController
  teardown: () => void
}

let mounted: MountedDoc | null = null
let readOnly = false

/**
 * An image the user asked to put INSIDE a table cell.
 *
 * The native picker covers the editor and can blur the selection, so the
 * caret's position is captured before the request goes out and restored when
 * the bytes come back — desktop's `use-table-cell-image` does the same. No new
 * bridge message: the round trip is the existing `insert-request` /
 * `insert-attachment` pair, and this is the guest remembering what it asked
 * for. If the memory is lost the attachment simply lands as a block, which is
 * what it did before this existed.
 */
let pendingCellImage: { docId: string; pos: number } | null = null

const viewport = installVisibleViewportInset((visible) => {
  if (!mounted) return
  mounted.toolbar.setKeyboardVisible(visible)
  bridge.send({ type: 'keyboard-visibility', docId: mounted.docId, visible })
  bridge.flush()
})

bridge.onHostMsg((msg) => {
  switch (msg.type) {
    // Timing only. It must stay the cheapest possible handler, because the
    // number it produces is the time to GET here and any work under it would
    // be counted as part of the crossing (#2044).
    case 'probe':
      markGuest(msg.slot === 'early' ? 'probeEarlyRecv' : 'probeLateRecv')
      break

    case 'doc-load':
      // Before the first mark of the open, so the record it starts is this
      // open's and not the previous note's (#2030).
      beginOpenMarks()
      markGuest('docLoadRecv')
      mountDoc(msg.docId, msg.stateB64, msg.seedMarkdown)
      break

    case 'y-update': {
      if (!mounted || !isForMountedDoc(msg, mounted.docId)) return
      // One transact for the whole batch: applying updates one at a time
      // fires one ProseMirror re-render each, which is what makes a remote
      // paste feel like a stutter instead of an edit.
      mounted.doc.transact(() => {
        for (const b64 of msg.updatesB64) {
          Y.applyUpdate(mounted!.doc, base64ToBytes(b64), REMOTE_ORIGIN)
        }
      }, REMOTE_ORIGIN)
      break
    }

    case 'cfg':
      applyCfg(msg)
      break

    case 'insert-attachment': {
      if (!mounted || !isForMountedDoc(msg, mounted.docId)) return
      if (insertPendingCellImage(mounted.editor, mounted.docId, msg.ref, msg.name, msg.mime)) {
        mounted.toolbar.update(readToolbarSelection(mounted.editor))
        break
      }
      insertAttachmentBlock(
        mounted.editor,
        msg.ref,
        msg.name,
        msg.mime,
        msg.blockType,
        msg.referenceBlockId
      )
      mounted.toolbar.update(readToolbarSelection(mounted.editor))
      break
    }

    case 'export-markdown': {
      if (!mounted || !isForMountedDoc(msg, mounted.docId)) return
      const editor = mounted.editor
      try {
        const markdown = editor.blocksToMarkdownLossy(editor.document)
        bridge.send({
          type: 'markdown-export',
          reqId: msg.reqId,
          docId: mounted.docId,
          result: { status: 'ok', markdown }
        })
      } catch (error) {
        bridge.send({
          type: 'markdown-export',
          reqId: msg.reqId,
          docId: mounted.docId,
          result: {
            status: 'error',
            detail: error instanceof Error ? error.message : String(error)
          }
        })
      }
      bridge.flush()
      break
    }

    case 'export-html': {
      // Answered even when the request is not for the mounted document, which
      // is the one way this differs from `export-markdown`. Returning in
      // silence leaves the host's promise to run out its own timeout, and that
      // timeout is 15 s — long enough for a reader who tapped Export during a
      // note switch to conclude the app has hung. `msg.docId` rather than the
      // mounted one, so the host's own docId check on the reply matches.
      if (!mounted || !isForMountedDoc(msg, mounted.docId)) {
        bridge.send({
          type: 'html-export',
          reqId: msg.reqId,
          docId: msg.docId,
          result: { status: 'error', detail: 'That note is no longer open here' }
        })
        bridge.flush()
        return
      }
      try {
        bridge.send({
          type: 'html-export',
          reqId: msg.reqId,
          docId: mounted.docId,
          result: { status: 'ok', html: renderDocumentHtml() }
        })
      } catch (error) {
        bridge.send({
          type: 'html-export',
          reqId: msg.reqId,
          docId: mounted.docId,
          result: {
            status: 'error',
            detail: error instanceof Error ? error.message : String(error)
          }
        })
      }
      bridge.flush()
      break
    }

    case 'exec':
      if (!isForMountedDoc(msg, mounted?.docId ?? null)) return
      runExec(msg.cmd)
      break
  }
})

function mountDoc(docId: string, stateB64: string, seedMarkdown?: string): void {
  mounted?.teardown()
  pendingCellImage = null

  const doc = new Y.Doc()
  if (stateB64.length > 0) {
    Y.applyUpdate(doc, base64ToBytes(stateB64), REMOTE_ORIGIN)
  }

  const fragment = doc.getXmlFragment(BRIDGE_FRAGMENT_NAME)
  markGuest('yApplied')

  markGuest('createStart')
  const editor = createEditor(fragment)
  markGuest('createEnd')

  root.replaceChildren()
  editor.mount(root)
  // This document outlives the note it shows, and nothing else puts the
  // scroller back: without it the next note opens at the offset the reader
  // left the previous one at, part-way down a document it has never seen.
  window.scrollTo(0, 0)
  markGuest('mountEnd')
  editor.isEditable = !readOnly

  const onUpdate = (update: Uint8Array, origin: unknown): void => {
    // Remote updates came FROM RN; echoing them back would re-append every
    // pulled update to the outbox on every open.
    if (origin === REMOTE_ORIGIN) return
    bridge.send({ type: 'y-update', docId, updatesB64: [bytesToBase64(update)] })
  }
  doc.on('update', onUpdate)

  const detachNav = installWikiLinkNavigation(root, bridge)
  const detachExternalLinks = installExternalLinks(root, bridge)
  const detachAssets = installImageResolver(root)
  const detachMetrics = installMetrics(root, bridge)
  chrome.replaceChildren()
  const findHost = document.createElement('div')
  const toolbarHost = document.createElement('div')
  chrome.append(findHost, toolbarHost)
  // After `replaceChildren`, or the menu is swept out of the chrome layer the
  // moment the toolbar claims it.
  const wikiLinks = installWikiLinkAutocomplete(
    {
      replaceQuery: (back, forward, target, alias) =>
        replaceQuery(editor, back, forward, target, alias),
      replaceQueryWithTag: (back, forward, tag, color, icon) =>
        replaceQuery(editor, back, forward, hashTagNode(tag, color, icon)),
      unpromoteAdjacent: (direction) => unpromoteAdjacent(editor, direction)
    },
    bridge,
    { root, chrome, toolbarHost }
  )
  let toolbarPanelOpen = false
  let findOpen = false
  const reportPanelVisibility = (): void => {
    bridge.send({
      type: 'editor-panel-visibility',
      docId,
      open: toolbarPanelOpen || findOpen
    })
    bridge.flush()
  }
  const toolbar = installEditorToolbar(
    toolbarHost,
    toolbarActions(editor, docId, bridge, wikiLinks),
    (open) => {
      toolbarPanelOpen = open
      reportPanelVisibility()
    }
  )
  const find = installFindInNote(findHost, root, (state) => {
    toolbar.setSuppressed(state.open)
    findOpen = state.open
    reportPanelVisibility()
  })
  toolbar.setReadOnly(readOnly)
  toolbar.setKeyboardVisible(viewport.getState().keyboardVisible)
  const detachToolbarSelection = editor.onSelectionChange(() => {
    toolbar.update(readToolbarSelection(editor))
  })
  toolbar.update(readToolbarSelection(editor))

  // Seeding is deliberately AFTER the doc is wired up: the parsed blocks then
  // travel the ordinary local-update path, so the seed is persisted and queued
  // like anything the user typed rather than living only in this replica.
  if (seedMarkdown && seedMarkdown.trim().length > 0 && isEditorEmpty(editor)) {
    try {
      const blocks = editor.tryParseMarkdownToBlocks(seedMarkdown)
      if (blocks.length > 0) editor.replaceBlocks(editor.document, blocks)
    } catch (err) {
      bridge.send({ type: 'err', code: 'SEED_PARSE_FAILED', detail: String(err) })
      bridge.flush()
    }
  }
  // Taken unconditionally, including on the far commoner path where there is
  // nothing to seed: a mark that only exists on the expensive branch reports an
  // empty column instead of a zero, and an empty column reads as "not measured".
  markGuest('seedEnd')

  mounted = {
    docId,
    doc,
    editor,
    toolbar,
    find,
    teardown: () => {
      doc.off('update', onUpdate)
      detachNav()
      wikiLinks.detach()
      detachExternalLinks()
      detachAssets()
      detachMetrics()
      detachToolbarSelection()
      find.destroy()
      toolbar.destroy()
      editor.unmount()
      doc.destroy()
    }
  }

  bridge.markLoaded()
  bridge.send({
    type: 'keyboard-visibility',
    docId,
    visible: viewport.getState().keyboardVisible
  })
  bridge.send({
    type: 'editor-panel-visibility',
    docId,
    open: toolbar.isPanelOpen()
  })
  bridge.flush()

  // The frame callback runs once the mounted document has been styled and laid
  // out, at the frame boundary just before the compositor presents it — so this
  // UNDER-reports the on-screen moment by at most one frame and never
  // over-reports. Flushed immediately rather than batched: a 24 ms delay on the
  // one message whose whole job is timing would be measuring the instrument.
  requestAnimationFrame(() => {
    markGuest('guestPainted')
    bridge.send({ type: 'painted', docId, marks: guestMarks() })
    bridge.flush()
  })
}

/**
 * The mounted note as a standalone HTML document, for the host's PDF/HTML export.
 *
 * A SNAPSHOT of what is already on screen, not a second renderer: the subtree
 * is the one BlockNote laid out and the rules are the ones it laid it out
 * under, so an export can never disagree with the note. Images come along for
 * free — `images.ts` has already swapped their vault refs for `data:` URIs in
 * this DOM — which also satisfies WKWebView's refusal to load local asset URLs
 * when printing.
 *
 * The wrapper keeps the `id="root"`, because the document's page padding and
 * inline measure are written against that selector and a bare `<body>` would
 * export the text hard against the paper edge. `#editor-chrome` is deliberately
 * left out: the toolbar and the find bar are app furniture, not the note. The
 * inline custom properties the host sets on `<html>` are left out for the same
 * reason and by construction — they are element styles rather than rules, so
 * the native header's reserved inset falls back to its own `0px` and the
 * exported page does not open with a band of empty paper.
 */
function renderDocumentHtml(): string {
  const styles = Array.from(document.querySelectorAll('style'))
    .map((element) => element.textContent ?? '')
    .join('\n')
  const snapshot = root.cloneNode(true) as HTMLElement
  stripEditingAffordances(snapshot)
  return (
    `<!doctype html><html lang="${document.documentElement.lang || 'en'}" dir="${document.documentElement.dir || 'ltr'}">` +
    `<head><meta charset="utf-8"><style>${styles}</style></head>` +
    `<body><div id="root">${snapshot.innerHTML}</div></body></html>`
  )
}

/**
 * Attributes that make the live editor an editor, removed from the export.
 *
 * Without this the `.html` file opens in a browser as a focusable, typeable
 * text box announcing itself as "Note content" — a copy of the editor rather
 * than a copy of the note. It has to walk descendants too: ProseMirror marks
 * atoms like wiki-link chips and images `contenteditable="false"`, so the
 * attribute appears well below the one element BlockNote owns.
 *
 * Only attributes are touched. Classes stay, because they ARE the styling the
 * exported stylesheet matches on, and the find bar needs no cleanup at all —
 * it highlights through the CSS Custom Highlight API, which never enters the
 * DOM.
 */
const EDITING_ATTRIBUTES = [
  'contenteditable',
  'tabindex',
  'role',
  'spellcheck',
  'autocorrect',
  'autocapitalize'
]

function stripEditingAffordances(element: HTMLElement): void {
  for (const node of [element, ...Array.from(element.querySelectorAll('*'))]) {
    for (const name of EDITING_ATTRIBUTES) node.removeAttribute(name)
    for (const attribute of Array.from(node.attributes)) {
      if (attribute.name.startsWith('aria-')) node.removeAttribute(attribute.name)
    }
  }
}

/**
 * Whether the document holds nothing but its trailing empty paragraph.
 *
 * BlockNote always keeps one block, so "no blocks" is never the answer; an
 * empty doc is a single block with no content.
 */
function isEditorEmpty(editor: MobileEditor): boolean {
  const blocks = editor.document
  if (blocks.length > 1) return false
  const only = blocks[0]
  if (!only) return true
  const content = only.content
  return !Array.isArray(content) || content.length === 0
}

/**
 * Insert an uploaded attachment at the cursor.
 *
 * An image block for `image/*`, a file block for everything else — routing a
 * PDF through the image path leaves a permanently broken picture. Either way
 * the block carries the vault-relative REFERENCE, which is what the note
 * stores and what desktop resolves; `images.ts` swaps in renderable bytes at
 * the DOM level without touching the document.
 */
function insertAttachmentBlock(
  editor: MobileEditor,
  ref: string,
  name: string,
  mime: string,
  requestedType?: 'image' | 'file',
  referenceBlockId?: string
): void {
  const at =
    (referenceBlockId && editor.getBlock(referenceBlockId)) || editor.getTextCursorPosition().block
  const blockType = requestedType ?? (mime.startsWith('image/') ? 'image' : 'file')
  const block =
    blockType === 'image'
      ? { type: 'image' as const, props: { url: ref, caption: name } }
      : { type: 'file' as const, props: { url: ref, name, mimeType: mime } }
  const inserted = editor.insertBlocks([block], at, 'after')[0]
  if (!inserted) return
  const paragraph = editor.insertBlocks([{ type: 'paragraph' }], inserted, 'after')[0]
  if (paragraph) editor.setTextCursorPosition(paragraph)
}

type PartialMobileBlock = Parameters<MobileEditor['insertBlocks']>[0][number]

function partialBlock(block: ConvertibleBlock): PartialMobileBlock {
  switch (block.kind) {
    case 'paragraph':
      return { type: 'paragraph' }
    case 'heading':
      return { type: 'heading', props: { level: block.level } }
    case 'bulletListItem':
      return { type: 'bulletListItem' }
    case 'numberedListItem':
      return { type: 'numberedListItem' }
    case 'checkListItem':
      return { type: 'checkListItem' }
    case 'toggleListItem':
      return { type: 'toggleListItem' }
    case 'quote':
      return { type: 'quote' }
    case 'codeBlock':
      return { type: 'codeBlock' }
    case 'callout':
      return { type: 'callout' }
    default: {
      const _exhaustive: never = block
      return _exhaustive
    }
  }
}

function turnInto(editor: MobileEditor, target: ConvertibleBlock): void {
  const selection = editor.getSelection()
  const blocks = selection?.blocks ?? [editor.getTextCursorPosition().block]
  editor.transact(() => {
    for (const block of blocks) editor.updateBlock(block, partialBlock(target))
  })
}

function insertBlock(editor: MobileEditor, action: InsertBlockAction): void {
  const at = editor.getTextCursorPosition().block
  switch (action.kind) {
    case 'convertible': {
      const inserted = editor.insertBlocks([partialBlock(action.block)], at, 'after')[0]
      if (inserted) editor.setTextCursorPosition(inserted)
      return
    }
    case 'divider': {
      const inserted = editor.insertBlocks([{ type: 'divider' }], at, 'after')[0]
      if (!inserted) return
      const paragraph = editor.insertBlocks([{ type: 'paragraph' }], inserted, 'after')[0]
      if (paragraph) editor.setTextCursorPosition(paragraph)
      return
    }
    case 'table': {
      const inserted = editor.insertBlocks(
        [
          {
            type: 'table',
            content: {
              type: 'tableContent',
              // Desktop inserts one header plus two body rows because the GFM
              // storage format cannot round-trip a header-less table.
              headerRows: 1,
              rows: [{ cells: ['', '', ''] }, { cells: ['', '', ''] }, { cells: ['', '', ''] }]
            }
          }
        ],
        at,
        'after'
      )[0]
      if (!inserted) return
      const paragraph = editor.insertBlocks([{ type: 'paragraph' }], inserted, 'after')[0]
      if (paragraph) editor.setTextCursorPosition(paragraph)
      return
    }
    case 'attachment':
    case 'wikiLink':
      return
    default: {
      const _exhaustive: never = action
      void _exhaustive
    }
  }
}

/* ---------------------------------------------------------------- */
/* Table editing (#2101)                                             */
/* ---------------------------------------------------------------- */

type TableBlock = Extract<MobileEditor['document'][number], { type: 'table' }>

/** The table the caret is inside, or `null` when it is not inside one. */
function tableBlockAt(editor: MobileEditor): TableBlock | null {
  const block = editor.getTextCursorPosition().block
  return block.type === 'table' ? (block as TableBlock) : null
}

function tableContentOf(block: TableBlock): TableContentLike {
  return block.content as unknown as TableContentLike
}

function readTableSelection(editor: MobileEditor): { structureLocked: boolean } | null {
  if (readTableCursor(editor) === null) return null
  const block = tableBlockAt(editor)
  // No block means the caret is in a cell of a table this schema cannot name,
  // which is not something to guess a row index against.
  if (!block) return { structureLocked: true }
  return { structureLocked: hasMergedCells(tableContentOf(block)) }
}

/**
 * Insert the picked image INTO the cell it was asked for.
 *
 * Returns whether it claimed the attachment; `false` sends it down the
 * ordinary block path. A cell is inline-only, so this is the only way a
 * picture reaches one — `inlineImage` exists for exactly this reason.
 */
function insertPendingCellImage(
  editor: MobileEditor,
  docId: string,
  ref: string,
  name: string,
  mime: string
): boolean {
  const pending = pendingCellImage
  // Consumed either way: a file the user picked instead of an image is not
  // going to arrive a second time.
  pendingCellImage = null
  if (!pending || pending.docId !== docId) return false
  if (!mime.startsWith('image/')) return false

  editor.transact((tr) => {
    const pos = Math.min(Math.max(pending.pos, 0), tr.doc.content.size)
    tr.setSelection(TextSelection.create(tr.doc, pos))
  })
  if (readTableCursor(editor) === null) return false
  editor.insertInlineContent([createInlineImageContent(ref, name)])
  return true
}

function runTableAction(
  editor: MobileEditor,
  docId: string,
  guest: GuestBridge,
  action: TableAction
): void {
  switch (action.kind) {
    case 'structure': {
      const cursor: TableCursor | null = readTableCursor(editor)
      const block = tableBlockAt(editor)
      if (!cursor || !block) return
      const next = applyTableStructureOp(tableContentOf(block), cursor, action.op)
      // `null` is "the table does not allow that" — the last body row, a move
      // off the end, a merged cell. Nothing to report and nothing to write.
      if (!next) return
      editor.updateBlock(block, {
        content: next as unknown as TableBlock['content']
      })
      return
    }

    case 'inline-checkbox':
      editor.insertInlineContent([createInlineCheckboxContent(false), ' '])
      return

    case 'inline-image': {
      const block = tableBlockAt(editor)
      if (!block) return
      pendingCellImage = { docId, pos: editor.transact((tr) => tr.selection.from) }
      const active = document.activeElement
      if (active instanceof HTMLElement) active.blur()
      guest.send({ type: 'insert-request', docId, blockType: 'image', referenceBlockId: block.id })
      guest.flush()
      return
    }

    case 'delete-table': {
      const block = tableBlockAt(editor)
      if (!block) return
      editor.removeBlocks([block])
      return
    }

    default: {
      const _exhaustive: never = action
      void _exhaustive
    }
  }
}

function blockLabel(editor: MobileEditor): string {
  const block = editor.getTextCursorPosition().block
  switch (block.type) {
    case 'paragraph':
      return 'T'
    case 'heading':
      return `H${block.props.level}`
    case 'bulletListItem':
      return '•'
    case 'numberedListItem':
      return '1.'
    case 'checkListItem':
      return '✓'
    case 'toggleListItem':
      return '▸'
    case 'quote':
      return '“'
    case 'codeBlock':
      return '</>'
    case 'callout':
      return '!'
    case 'divider':
      return '—'
    case 'table':
      return '▦'
    case 'image':
      return '▧'
    case 'file':
      return '⌑'
    case 'audio':
      return '♪'
    case 'video':
    case 'youtubeEmbed':
      return '▶'
    case 'bookmark':
      return '⌁'
    case 'taskBlock':
      return '✓'
    default:
      return 'T'
  }
}

function readToolbarSelection(editor: MobileEditor): EditorToolbarSelection {
  const styles = editor.getActiveStyles()
  return {
    blockLabel: blockLabel(editor),
    table: readTableSelection(editor),
    alignment: readAlignment(editor.getTextCursorPosition().block.props),
    textColour: readColour(styles.textColor),
    backgroundColour: readColour(styles.backgroundColor),
    canNest: editor.canNestBlock(),
    canUnnest: editor.canUnnestBlock(),
    activeStyles: {
      bold: styles.bold === true,
      italic: styles.italic === true,
      underline: styles.underline === true,
      strike: styles.strike === true,
      code: styles.code === true
    }
  }
}

function toggleStyle(editor: MobileEditor, style: InlineStyle): void {
  switch (style) {
    case 'bold':
      editor.toggleStyles({ bold: true })
      return
    case 'italic':
      editor.toggleStyles({ italic: true })
      return
    case 'underline':
      editor.toggleStyles({ underline: true })
      return
    case 'strike':
      editor.toggleStyles({ strike: true })
      return
    case 'code':
      editor.toggleStyles({ code: true })
      return
    default: {
      const _exhaustive: never = style
      void _exhaustive
    }
  }
}

function toolbarActions(
  editor: MobileEditor,
  docId: string,
  guest: GuestBridge,
  wiki: WikiLinkAutocomplete
) {
  const refresh = (): void => mounted?.toolbar.update(readToolbarSelection(editor))
  // `execCommand` reaches ProseMirror as a `beforeinput` it handles itself, so
  // no `input` event escapes to the autocomplete's own listener. Opening the
  // menu explicitly is what makes the toolbar button do anything at all.
  // Both brackets go in at once and the caret is walked back between them, so
  // the button leaves a finished `[[]]` the user types INTO rather than a half
  // token they have to close themselves. `execCommand` reaches ProseMirror as a
  // `beforeinput` it handles itself, so no `input` event escapes to the
  // autocomplete's own listener -- opening the menu explicitly is what makes
  // the button do anything at all.
  const openWikiLink = (): void => {
    editor.focus()
    document.execCommand('insertText', false, '[[]]')
    const selection = document.getSelection()
    if (selection?.isCollapsed) {
      // `modify` over `collapse`: ProseMirror re-reads the DOM selection, and a
      // raw offset set against a node it is about to replace lands nowhere.
      selection.modify('move', 'backward', 'character')
      selection.modify('move', 'backward', 'character')
    }
    wiki.open()
    refresh()
  }
  const refocus = (): void => {
    editor.focus()
    refresh()
  }
  const requestAttachment = (blockType: 'image' | 'file'): void => {
    const referenceBlockId = editor.getTextCursorPosition().block.id
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
    guest.send({ type: 'insert-request', docId, blockType, referenceBlockId })
    guest.flush()
  }

  return {
    insert(action: InsertBlockAction): void {
      if (action.kind === 'attachment') {
        requestAttachment(action.blockType)
        return
      }
      if (action.kind === 'wikiLink') {
        openWikiLink()
        return
      }
      insertBlock(editor, action)
      refocus()
    },
    tableAction(action: TableAction): void {
      runTableAction(editor, docId, guest, action)
      refresh()
    },
    styleAction(action: StyleAction): void {
      // No `focus()` first: the style panel replaced the keyboard, and taking
      // focus back here would raise it again under the open panel.
      runStyleAction(editor, action)
      refresh()
    },
    turnInto(block: ConvertibleBlock): void {
      turnInto(editor, block)
      refocus()
    },
    toggleStyle(style: InlineStyle): void {
      toggleStyle(editor, style)
      refocus()
    },
    toggleBulletedList(): void {
      const current = editor.getTextCursorPosition().block
      turnInto(
        editor,
        current.type === 'bulletListItem' ? { kind: 'paragraph' } : { kind: 'bulletListItem' }
      )
      refocus()
    },
    createLink(url: string): void {
      editor.focus()
      editor.createLink(url)
      refresh()
    },
    focusEditor(): void {
      refocus()
    },
    insertWikiLink(): void {
      openWikiLink()
    },
    insertImage(): void {
      requestAttachment('image')
    },
    undo(): void {
      editor.undo()
      refocus()
    },
    redo(): void {
      editor.redo()
      refocus()
    },
    dismissKeyboard(): void {
      const active = document.activeElement
      if (active instanceof HTMLElement) active.blur()
      guest.flush()
    }
  }
}

function applyCfg(cfg: {
  theme: 'light' | 'dark'
  locale: string
  rtl: boolean
  reducedMotion: boolean
  readOnly: boolean
  headerHeight?: number
  keyboardHeight?: number
}): void {
  const html = document.documentElement
  html.setAttribute('data-theme', cfg.theme)
  html.setAttribute('lang', cfg.locale)
  // Logical direction, not a mirrored stylesheet: the editor's own CSS is
  // written in logical properties, so `dir` alone flips it correctly.
  html.setAttribute('dir', cfg.rtl ? 'rtl' : 'ltr')
  html.classList.toggle('reduced-motion', cfg.reducedMotion)
  // Padding rather than a shorter document: the host draws its header over this
  // page and never resizes the frame, so the reader scrolls one distance and
  // the header travels the same one. Live, because the header is the note's own
  // title block and grows as tags and properties are added to it.
  html.style.setProperty('--memry-header-inset', `${Math.max(0, cfg.headerHeight ?? 0)}px`)
  // The host's own keyboard measurement, which the block picker sizes itself
  // from. See `keyboardHeight` on the cfg message for why the guest cannot
  // measure it.
  html.style.setProperty('--memry-keyboard-height', `${Math.max(0, cfg.keyboardHeight ?? 0)}px`)
  readOnly = cfg.readOnly
  if (mounted) {
    mounted.editor.isEditable = !cfg.readOnly
    mounted.toolbar.setReadOnly(cfg.readOnly)
  }
}

function runExec(cmd: BridgeExecCommand): void {
  switch (cmd) {
    case 'undo':
      mounted?.editor.undo()
      break
    case 'redo':
      mounted?.editor.redo()
      break
    case 'focus':
      mounted?.editor.focus()
      break
    case 'blur':
      ;(document.activeElement as HTMLElement | null)?.blur()
      bridge.flush()
      break
    case 'flush':
      bridge.flush()
      break
    case 'open-find':
      mounted?.find.open()
      break
    default: {
      const _exhaustive: never = cmd
      void _exhaustive
    }
  }
}

/**
 * Content height and selection anchor for the native chrome. Reported on a
 * batched cadence like everything else — a per-frame height message is the
 * exact defect the batching rule exists to prevent.
 */
function installMetrics(element: HTMLElement, guest: GuestBridge): () => void {
  let lastHeight = -1
  let lastAnchor = -1
  let throttle: ReturnType<typeof setTimeout> | null = null

  const report = (): void => {
    const h = Math.ceil(element.scrollHeight)
    const selection = document.getSelection()
    let selAnchor = 0
    if (selection && selection.rangeCount > 0) {
      const rect = selection.getRangeAt(0).getBoundingClientRect()
      selAnchor = Math.round(rect.top + window.scrollY)
    }
    // Both values compared, and BOTH have to be unchanged to skip. The old
    // guard let any live caret through, so `selectionchange` — which fires on
    // every keystroke — put a message on the wire per character. That is the
    // per-keystroke crossing the batching rule exists to prevent, and it also
    // inflated the received-message count the G3 batching proof divides.
    if (h === lastHeight && selAnchor === lastAnchor) return
    lastHeight = h
    lastAnchor = selAnchor
    guest.send({ type: 'metrics', h, selAnchor })
  }

  // Trailing-edge throttle: native chrome needs the SETTLED height, not every
  // intermediate one during a burst of typing.
  const schedule = (): void => {
    if (throttle !== null) return
    throttle = setTimeout(() => {
      throttle = null
      report()
    }, METRICS_THROTTLE_MS)
  }

  const observer = new ResizeObserver(schedule)
  observer.observe(element)
  document.addEventListener('selectionchange', schedule)
  return () => {
    if (throttle !== null) clearTimeout(throttle)
    observer.disconnect()
    document.removeEventListener('selectionchange', schedule)
  }
}

/**
 * Report the document's scroll offset so the native header can ride it.
 *
 * Once per animation frame at most, coalescing the burst WebKit fires during a
 * fling. Not flushed explicitly: the bridge's own 24 ms cadence carries it,
 * which keeps this off the per-event-crossing path the batching rule forbids
 * and still puts the header within a frame and a half of the finger.
 *
 * Installed once for the WebView rather than per note, like the guest's other
 * document-level listeners: `window` is the scroller, it outlives every
 * `mountDoc`, and `mountDoc` resets it to 0 — which reports itself here and
 * puts the next note's header back at the top.
 */
function installScrollReports(guest: GuestBridge): void {
  let frame: number | null = null
  let lastY = -1

  const report = (): void => {
    frame = null
    const y = Math.max(0, Math.round(window.scrollY))
    if (y === lastY) return
    lastY = y
    guest.send({ type: 'scroll', y })
  }

  window.addEventListener(
    'scroll',
    () => {
      if (frame !== null) return
      frame = requestAnimationFrame(report)
    },
    { passive: true }
  )
}

installScrollReports(bridge)

// The flush the contract requires on a background transition. `pagehide` is
// the only event WKWebView reliably delivers before iOS suspends the process.
window.addEventListener('pagehide', () => bridge.flush())
window.addEventListener('blur', () => bridge.flush())

window.addEventListener('error', (event) => {
  bridge.send({ type: 'err', code: 'EDITOR_UNCAUGHT', detail: String(event.message) })
  bridge.flush()
})
window.addEventListener('unhandledrejection', (event) => {
  bridge.send({ type: 'err', code: 'EDITOR_UNHANDLED_REJECTION', detail: String(event.reason) })
  bridge.flush()
})

// Dev-build counter surface: read by the RN rig for the G3 batching proof
// (T075). Not a bridge message — the rig pulls it, nothing pushes it.
;(globalThis as Record<string, unknown>).__memryBridgeCounters = () => bridge.getCounters()

bridge.sendReady(schemaV, __EDITOR_WEB_CONTRACT_HASH__)
markGuest('readySent')
traceIdleTicks()

// ---------------------------------------------------------------------------

/**
 * Is this document's JS thread alive while it waits for `doc-load`? (#2044)
 *
 * The wait is 3-5 s and the tiny probe envelope crosses no faster than the real
 * one, so the payload is not what is being waited on. Two very different faults
 * produce that: a web content process WebKit has suspended or starved, in which
 * case nothing here runs either; or a delivery that simply never arrives, in
 * which case this document is idle and perfectly healthy the whole time. A
 * timer separates them, and nothing observable from the host can.
 *
 * It stops the moment `doc-load` lands. Past that point the ticks measure
 * nothing and a 100 ms timer under a live editor is pure noise — so the cost in
 * an app nobody is measuring is bounded by the very interval the epic exists to
 * remove.
 */
function traceIdleTicks(): void {
  let first = true
  const timer = setInterval(() => {
    if (first) {
      markGuest('idleTickFirst')
      first = false
    }
    markGuest('idleTickLast')
  }, 100)

  // Registered after the main handler, so this runs once that has finished
  // mounting; the last tick is therefore the last one BEFORE the document
  // arrived, which is the number the fork above turns on.
  bridge.onHostMsg((msg) => {
    if (msg.type === 'doc-load') clearInterval(timer)
  })
}

/**
 * Time shiki's highlighter without moving it (#2043).
 *
 * `createCodeBlockSpec(codeBlockOptions)` runs at schema construction, but the
 * factory it captures is only CALLED from the highlight plugin's parser, on the
 * first code block the editor sees — so the grammar cost lands inside editor
 * construction, in the interval this issue is breaking down. The wrapper reads
 * the property off the same options object the spec holds, calls straight
 * through and returns the same promise, so the only difference on the wire is
 * three `Date.now()` calls.
 *
 * Split into three because they answer different questions: `shikiStart` to
 * `shikiSync` is what BLOCKS the thread, and `shikiSync` to `shikiEnd` is the
 * asynchronous tail that a paint can and does overtake.
 */
function traceHighlighter(): void {
  const create = codeBlockOptions.createHighlighter
  codeBlockOptions.createHighlighter = () => {
    markGuest('shikiStart')
    const highlighter = create()
    markGuest('shikiSync')
    void highlighter.then(
      () => markGuest('shikiEnd'),
      () => markGuest('shikiEnd')
    )
    return highlighter
  }
}

function fingerprintSchema(built: {
  blockSchema: Record<string, unknown>
  inlineContentSchema: Record<string, unknown>
}): string {
  const names = [
    ...Object.keys(built.blockSchema).map((n) => `b:${n}`),
    ...Object.keys(built.inlineContentSchema).map((n) => `i:${n}`)
  ].sort()
  // A plain content hash: RN only needs to know whether the two sides agree,
  // not what changed, and this stays stable across builds of the same schema.
  let hash = 0x811c9dc5
  for (const name of names.join('|')) {
    hash ^= name.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Turn the wiki link the cursor is sitting against back into `[[…]]` text.
 *
 * Desktop's rule, and the reason it exists: a finished chip is an atom, so
 * Backspace next to one deletes the entire link when all the user wanted was
 * to add a `#Heading` or a `|Alias` to it. Un-promoting hands the raw form
 * back with the caret at the END of the target, which is exactly where both of
 * those go. Desktop paints the same text with a decoration instead of writing
 * it; this writes it, so the un-promotion costs one undo step.
 */
function unpromoteAdjacent(editor: MobileEditor, direction: 'before' | 'after'): boolean {
  let done = false
  editor.transact((tr) => {
    const { $from, empty } = tr.selection
    if (!empty) return
    const node = direction === 'before' ? $from.nodeBefore : $from.nodeAfter
    if (node?.type.name !== 'wikiLink') return
    const target = String(node.attrs.target ?? '')
    if (!target) return
    const text = wikiLinkToText(target, String(node.attrs.alias ?? ''))
    const start = direction === 'before' ? $from.pos - node.nodeSize : $from.pos
    tr.replaceWith(start, start + node.nodeSize, tr.doc.type.schema.text(text))
    tr.setSelection(TextSelection.create(tr.doc, start + OPEN_TOKEN_LENGTH + target.length))
    done = true
  })
  return done
}

const OPEN_TOKEN_LENGTH = 2

/**
 * Swap the raw `[[query]]` run around the cursor for a wiki link, atomically.
 *
 * One transaction for the delete so the whole run goes in a single step. The
 * previous `execCommand('delete')` loop asked the browser to repeat a backward
 * delete N times and ProseMirror only honoured some of them, which left
 * `[[Note#` sitting in front of the finished chip on longer queries.
 */
function replaceQuery(
  editor: MobileEditor,
  back: number,
  forward: number,
  targetOrNode: string | ReturnType<typeof hashTagNode>,
  alias = ''
): void {
  editor.transact((tr) => {
    const { $from, from } = tr.selection
    // Clamped to the caret's own text block: a query can never have spilled
    // out of it, so anything past the edge belongs to a neighbour.
    const start = Math.max($from.start(), from - back)
    const end = Math.min($from.end(), from + forward)
    if (end > start) tr.delete(start, end)
  })
  const node = typeof targetOrNode === 'string' ? wikiLinkNode(targetOrNode, alias) : targetOrNode
  editor.insertInlineContent([node, ' '])
}

/**
 * A `hashTag` node ready for `insertInlineContent` (#2099).
 *
 * The colour and the icon are the vault's, handed down with the menu row, so a
 * tag picked on the phone writes the same three props desktop writes. An empty
 * colour is the honest answer for a tag nobody has coloured: it is what
 * desktop stores too, and every renderer hashes the name to the same hue.
 */
function hashTagNode(tag: string, color: string, icon: string) {
  return {
    type: 'hashTag' as const,
    props: { tag, color, icon }
  }
}

/**
 * A wiki-link node ready for `insertInlineContent`.
 *
 * The shared helper deliberately OMITS unset mark props — that is what keeps a
 * link promoted from plain text writing back as `{ target, alias }` — while
 * BlockNote's insert API types props as complete. The missing marks are
 * therefore filled from the schema's own defaults rather than a second
 * hard-coded copy, so a future mark added to the config comes along for free.
 */
function wikiLinkNode(target: string, alias: string) {
  const schemaProps = wikiLinkConfig.propSchema
  return {
    type: 'wikiLink' as const,
    props: {
      ...createWikiLinkInlineContent(target, alias).props,
      bold: schemaProps.bold.default,
      italic: schemaProps.italic.default,
      underline: schemaProps.underline.default,
      strike: schemaProps.strike.default,
      code: schemaProps.code.default,
      textColor: schemaProps.textColor.default,
      backgroundColor: schemaProps.backgroundColor.default
    }
  }
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  // Chunked: `String.fromCharCode(...bytes)` blows the argument limit on a
  // paste-sized update, which is exactly when it matters.
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
