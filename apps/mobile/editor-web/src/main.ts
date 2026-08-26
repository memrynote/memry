import * as Y from 'yjs'
import { BlockNoteEditor } from '@blocknote/core'
import { createWikiLinkInlineContent, wikiLinkConfig } from '@memry/editor-schema/inline'
import { BRIDGE_FRAGMENT_NAME } from '@memry/contracts/webview-bridge'
import { assertNoWebStorage, createGuestBridge, type GuestBridge } from './bridge.ts'
import { bindAssetBridge } from './assets.ts'
import { installImageResolver } from './images.ts'
import { createMobileEditorSchema } from './schema.ts'
import { installWikiLinkAutocomplete, installWikiLinkNavigation } from './wiki-links.ts'
import './styles.css'

/**
 * WebView editor entry (T057).
 *
 * The RN side owns the Y.Doc; this document holds a replica and persists
 * nothing. Updates the user makes here go out over the bridge and are durable
 * only once RN has written them to SQLite — which is why the local replica is
 * never treated as a source of truth, only as what the user is looking at.
 */

/** Origin tag on locally-applied remote updates; stops the echo loop. */
const REMOTE_ORIGIN = Symbol('memry-remote')

const bridge = createGuestBridge()
const root = document.getElementById('root')!

assertNoWebStorage()
bindAssetBridge(bridge)

const schema = createMobileEditorSchema()
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
    animations: false
  })
}

type MobileEditor = ReturnType<typeof createEditor>

interface MountedDoc {
  docId: string
  doc: Y.Doc
  editor: MobileEditor
  teardown: () => void
}

let mounted: MountedDoc | null = null
let readOnly = false

bridge.onHostMsg((msg) => {
  switch (msg.type) {
    case 'doc-load':
      mountDoc(msg.docId, msg.stateB64, msg.seedMarkdown)
      break

    case 'y-update': {
      if (!mounted || mounted.docId !== msg.docId) return
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
      if (!mounted) return
      insertAttachmentBlock(mounted.editor, msg.ref, msg.name, msg.mime)
      break
    }

    case 'exec':
      runExec(msg.cmd)
      break
  }
})

function mountDoc(docId: string, stateB64: string, seedMarkdown?: string): void {
  mounted?.teardown()

  const doc = new Y.Doc()
  if (stateB64.length > 0) {
    Y.applyUpdate(doc, base64ToBytes(stateB64), REMOTE_ORIGIN)
  }

  const fragment = doc.getXmlFragment(BRIDGE_FRAGMENT_NAME)
  const editor = createEditor(fragment)

  root.replaceChildren()
  editor.mount(root)
  editor.isEditable = !readOnly

  const onUpdate = (update: Uint8Array, origin: unknown): void => {
    // Remote updates came FROM RN; echoing them back would re-append every
    // pulled update to the outbox on every open.
    if (origin === REMOTE_ORIGIN) return
    bridge.send({ type: 'y-update', docId, updatesB64: [bytesToBase64(update)] })
  }
  doc.on('update', onUpdate)

  const detachNav = installWikiLinkNavigation(root, bridge)
  const detachAutocomplete = installWikiLinkAutocomplete(
    { insertWikiLink: (title) => editor.insertInlineContent([wikiLinkNode(title), ' ']) },
    bridge,
    root
  )
  const detachAssets = installImageResolver(root)
  const detachMetrics = installMetrics(root, bridge)

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

  mounted = {
    docId,
    doc,
    editor,
    teardown: () => {
      doc.off('update', onUpdate)
      detachNav()
      detachAutocomplete()
      detachAssets()
      detachMetrics()
      editor.unmount()
      doc.destroy()
    }
  }

  bridge.markLoaded()
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
  mime: string
): void {
  const at = editor.getTextCursorPosition().block
  const block = mime.startsWith('image/')
    ? { type: 'image' as const, props: { url: ref, caption: name } }
    : { type: 'file' as const, props: { url: ref, name } }
  editor.insertBlocks([block], at, 'after')
}

function applyCfg(cfg: {
  theme: 'light' | 'dark'
  locale: string
  rtl: boolean
  reducedMotion: boolean
  readOnly: boolean
}): void {
  const html = document.documentElement
  html.setAttribute('data-theme', cfg.theme)
  html.setAttribute('lang', cfg.locale)
  // Logical direction, not a mirrored stylesheet: the editor's own CSS is
  // written in logical properties, so `dir` alone flips it correctly.
  html.setAttribute('dir', cfg.rtl ? 'rtl' : 'ltr')
  html.classList.toggle('reduced-motion', cfg.reducedMotion)
  readOnly = cfg.readOnly
  if (mounted) mounted.editor.isEditable = !cfg.readOnly
}

function runExec(cmd: 'undo' | 'redo' | 'focus' | 'blur' | 'flush'): void {
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
  }
}

/**
 * Content height and selection anchor for the native chrome. Reported on a
 * batched cadence like everything else — a per-frame height message is the
 * exact defect the batching rule exists to prevent.
 */
function installMetrics(element: HTMLElement, guest: GuestBridge): () => void {
  let lastHeight = -1
  const report = (): void => {
    const h = Math.ceil(element.scrollHeight)
    const selection = document.getSelection()
    let selAnchor = 0
    if (selection && selection.rangeCount > 0) {
      const rect = selection.getRangeAt(0).getBoundingClientRect()
      selAnchor = Math.round(rect.top + window.scrollY)
    }
    if (h === lastHeight && selAnchor === 0) return
    lastHeight = h
    guest.send({ type: 'metrics', h, selAnchor })
  }
  const observer = new ResizeObserver(report)
  observer.observe(element)
  document.addEventListener('selectionchange', report)
  return () => {
    observer.disconnect()
    document.removeEventListener('selectionchange', report)
  }
}

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

// ---------------------------------------------------------------------------

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
 * A wiki-link node ready for `insertInlineContent`.
 *
 * The shared helper deliberately OMITS unset mark props — that is what keeps a
 * link promoted from plain text writing back as `{ target, alias }` — while
 * BlockNote's insert API types props as complete. The missing marks are
 * therefore filled from the schema's own defaults rather than a second
 * hard-coded copy, so a future mark added to the config comes along for free.
 */
function wikiLinkNode(title: string) {
  const schemaProps = wikiLinkConfig.propSchema
  return {
    type: 'wikiLink' as const,
    props: {
      ...createWikiLinkInlineContent(title, title).props,
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
