/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useRef } from 'react'
import { removeAndInsertBlocks, type Block } from '@blocknote/core'
import { yUndoPluginKey } from 'y-prosemirror'
import type * as Y from 'yjs'
import {
  extractHeadings,
  normalizeWikiLinks,
  normalizeMarkdownHardBreaks
} from '../wiki-link-utils'
import { normalizeHashTags, extractInlineTags } from '../hash-tag'
import { normalizeNoteBlocks } from '../normalize-note-blocks'
import { normalizeInlineCheckboxes } from '../inline-checkbox-utils'
import { normalizeDateMentions } from '../date-mention-utils'
import {
  parseMarkdownPreservingBlanks,
  sanitizeBlockIds,
  serializeBlocksPreservingBlanks
} from '../markdown-utils'
import { recordLoadedMarkdownSource, serializeMarkdownPreservingSource } from '../markdown-source'
import type { MarkdownSourceRecord } from '@memry/shared/markdown-source'
import { createLinkMentionContent } from '../link-mention'
import { normalizeLinkMentions } from '../link-mention-utils'
import { fetchLinkPreview } from '@/lib/url-metadata'
import type { HeadingInfo, InlineTagsOrigin } from '../types'
import { createLogger } from '@/lib/logger'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import { isEditingWikiLinkText } from '../wiki-link-edit-plugin'

const log = createLogger('Hook:EditorSync')
const activeNoteEditors = new Map<string, any>()

/**
 * The block to exempt from wiki-link promotion, or undefined when there is none.
 *
 * Narrow on purpose: ONLY while the caret sits inside a raw `[[…]]` run that the
 * user is editing (`wiki-link-edit-plugin.ts`). Exempting the caret's block
 * unconditionally would also stop a hand-typed `[[Note]]` from becoming a chip
 * until the caret left the block — that promotion is immediate today and there
 * is no reason for this to change it.
 *
 * Every lookup is defensive. BlockNote throws rather than returning null when the
 * selection is not in a block with content (an image block, a fresh editor), and
 * a normalization pass is not the place to care.
 */
function editingWikiLinkBlockId(editor: any): string | undefined {
  const state = editor?._tiptapEditor?.state
  if (!state || !isEditingWikiLinkText(state)) return undefined
  try {
    return editor.getTextCursorPosition?.()?.block?.id as string | undefined
  } catch {
    return undefined
  }
}

function replaceInitialBlocksWithoutHistory(editor: any, blocks: Block[]): void {
  if (typeof editor.transact !== 'function') {
    editor.replaceBlocks(editor.document, blocks)
    return
  }

  editor.transact((tr: any) => {
    tr.setMeta?.('addToHistory', false)
    return removeAndInsertBlocks(
      tr,
      editor.document,
      blocks as Parameters<typeof removeAndInsertBlocks>[2]
    )
  })
}

/**
 * Promote the raw `[[…]]` text a collaborative document opens with (#1642).
 *
 * Main parses the vault file into the shared Y.Doc with a `wikiLink` spec that
 * has no `parse` rule, so `[[X]]` reaches the doc as plain TEXT — the renderer
 * is the only thing that promotes it (`wiki-link-collab-promotion.test.ts`).
 * The load effect below never did: it returns early for a collaborative
 * document, so `normalizeNoteBlocks` runs on the markdown path only. Promotion
 * on this path was left entirely to `handleChange`, which fires on a change
 * EVENT — in practice the transaction y-prosemirror dispatches when the shared
 * content reaches the editor, which is why opening a note usually does show
 * chips. But nothing guarantees that event: it has to land after BlockNote's
 * `onChange` subscriber is registered, and when it does not there is no second
 * chance, because a document that is merely READ never changes again. That is
 * the reported failure — a page of links that opens as plain, unclickable text
 * and stays that way until the user types into it.
 *
 * So the open path promotes for itself, and stops depending on the event.
 *
 * A NORMAL `replaceBlocks`, deliberately: this is a CRDT mutation like any
 * other, so y-prosemirror diffs it into the shared doc and it converges with
 * every other device. `replaceInitialBlocksWithoutHistory` must not be used
 * here — it removes and re-inserts the whole document, which on a shared doc is
 * one device overwriting another's body.
 *
 * Idempotent by construction: a promoted `wikiLink` node carries its target in
 * props, so `[[` never reappears and `normalizeWikiLinks` stops matching. A
 * second open writes no CRDT update at all, which is what keeps "opening a note
 * must not rewrite it" (#1434) true. Hash tags still have no promoter here:
 * they need the note's tag list and colour map, so they must stay the bytes
 * they were opened with.
 */
function promoteWikiLinksInSharedDoc(editor: any): void {
  const normalized = normalizeWikiLinks(editor.document as Block[], {
    skipBlockId: editingWikiLinkBlockId(editor)
  })
  if (!normalized.didChange) return

  editor.replaceBlocks(editor.document, normalized.blocks)
}

/**
 * Promote the raw `[ ]` text a collaborative document opens with.
 *
 * Exactly the same gap `promoteWikiLinksInSharedDoc` above closes, for the same
 * reason: `normalizeNoteBlocks` runs on the markdown path only, and the
 * collaborative path returns before it. Main parses the vault file into the
 * shared Y.Doc with an `inlineCheckbox` spec whose `parse` claims an
 * `<input type=checkbox>` — and there is never one, because GFM's task-list
 * syntax is list-item only, so `| [ ] task |` reaches the doc as plain TEXT.
 * The renderer is the only thing that can turn it back into a control.
 *
 * ON OPEN ONLY, deliberately — this is NOT added to `handleChange` the way wiki
 * links are. A bare `[ ]` with nothing after it is a cell a user may be
 * mid-way through typing, and promoting on every change would turn the third
 * keystroke of a literal `[ ]` into a checkbox under their cursor. The typing
 * gesture is owned by `inline-checkbox-plugin.ts`, which waits for the space
 * that completes the token; this pass only ever sees text that was already on
 * disk. An external edit that arrives later is promoted on the next open.
 *
 * Idempotent by construction: a promoted node leaves no `[ ]` text behind, so a
 * second open writes no CRDT update at all — which is what keeps "opening a
 * note must not rewrite it" (#1434) true. The bytes are unchanged either way,
 * since the node serializes back to the token it was promoted from.
 */
function promoteInlineCheckboxesInSharedDoc(editor: any): void {
  const normalized = normalizeInlineCheckboxes(editor.document as Block[])
  if (!normalized.didChange) return

  editor.replaceBlocks(editor.document, normalized.blocks)
}

/**
 * Promote the raw `((date:…))` text a collaborative document opens with (#1845).
 *
 * The third instance of the gap above, and the one a user cannot read past.
 * Main parses the vault file into the shared Y.Doc with a `dateMention` spec
 * whose `parse` claims a `data-date-mention` element — markdown has none — so
 * the token reaches the doc as plain TEXT, and the renderer is the only thing
 * that can turn it back into a pill. The load effect returns before
 * `normalizeNoteBlocks` on this path, so nothing did: a note whose CRDT doc is
 * rebuilt from disk (a restart, a vault switch, a new device) opened showing a
 * two-hundred-character base64 run where the date had been. A reminder pill is
 * worse off than any other node here, because its text carries no readable
 * fallback at all.
 *
 * Byte-neutral for a well-formed token: the promoted node re-serializes to the
 * bytes it was promoted from, so a second open writes no CRDT update and
 * "opening a note must not rewrite it" (#1434) still holds. A token the parser
 * refuses is salvaged to a plain date instead, which does change the bytes —
 * once, on a note that was already unreadable.
 */
function promoteDateMentionsInSharedDoc(editor: any): void {
  const normalized = normalizeDateMentions(editor.document as Block[])
  if (!normalized.didChange) return

  editor.replaceBlocks(editor.document, normalized.blocks)
}

/**
 * Promote the `((mention:…))` tokens a collaborative document opens with.
 *
 * The same gap the two promoters above close, and the one that made a saved
 * mention come back as literal text after a restart or a vault switch (#1844):
 * main seeds the shared doc straight from the vault file, where a mention is
 * plain text, and this path returns before `normalizeNoteBlocks` ever runs.
 *
 * Idempotent from the first open onwards — a promoted `linkMention` serializes
 * back to the token it was built from, so `((mention:` is gone from the
 * document and the second open matches nothing and writes no update. The one
 * exception is a token whose URL holds `_ * ! ~ '`, which older builds wrote
 * with those characters raw: promoting it rewrites the token in the closed
 * alphabet once, and every open after that is a no-op.
 *
 * No favicon hydration here, deliberately. `hydrateLinkMentionFavicons` writes
 * back a content array it captured before its fetch, which on a shared document
 * would push a stale block to every device, and it resolves after
 * `clearYjsUndoHistory` has run, leaving the open undoable. A chip promoted
 * here renders its domain, which is what the token carries.
 */
function promoteLinkMentionsInSharedDoc(editor: any): void {
  const normalized = normalizeLinkMentions(editor.document as Block[])
  if (!normalized.didChange) return

  editor.replaceBlocks(editor.document, normalized.blocks)
}

function clearYjsUndoHistory(editor: any): void {
  const state = editor?._tiptapEditor?.state
  if (!state) return

  const undoManager = yUndoPluginKey.getState(state)?.undoManager
  undoManager?.clear?.(true, true)
  undoManager?.stopCapturing?.()
}

export async function extractMarkdownFromActiveEditor(noteId?: string): Promise<string | null> {
  if (!noteId) return null

  const editor = activeNoteEditors.get(noteId)
  if (!editor) return null

  return serializeBlocksPreservingBlanks(editor, editor.document as Block[])
}

function hydrateLinkMentionFavicons(editor: any): void {
  const mentions: { block: any; index: number; url: string }[] = []

  const walk = (blocks: any[]): void => {
    for (const block of blocks) {
      const content = block.content
      if (Array.isArray(content)) {
        content.forEach((c: any, i: number) => {
          if (
            c.type === 'linkMention' &&
            c.props?.url &&
            (!c.props.favicon || !c.props.siteName || !c.props.title)
          ) {
            mentions.push({ block, index: i, url: c.props.url })
          }
        })
      }
      if (block.children?.length) walk(block.children)
    }
  }

  walk(editor.document)

  for (const { block, index, url } of mentions) {
    fetchLinkPreview(url)
      .then((metadata) => {
        const current = block.content
        if (!Array.isArray(current)) return
        if (current[index]?.type !== 'linkMention') return
        const updated = [...current]
        updated[index] = createLinkMentionContent(
          url,
          metadata.domain || current[index].props.domain,
          metadata.title || current[index].props.title,
          metadata.favicon,
          metadata.siteName || current[index].props.siteName
        )
        editor.updateBlock(block, { content: updated })
      })
      .catch(() => {})
  }
}

interface EditorSyncParams {
  editor: any
  noteId?: string
  /** Vault-relative path of the note, so embed targets resolve relative to it. */
  notePath?: string
  initialContent?: Block[] | string
  contentType?: 'html' | 'markdown' | 'blocks'
  yjsFragment?: Y.XmlFragment
  /**
   * Bumped by the owner when `initialContent` was replaced by an edit that did
   * NOT come from this editor (device sync, an on-disk edit, an agent write).
   * The editor is an uncontrolled component, so without this the content only
   * loads once per instance and the owner has to remount the whole editor.
   */
  externalContentRevision?: number
  isRemoteUpdateRef?: React.RefObject<boolean>
  noteTags?: string[]
  tagColorMap?: Map<string, string>
  tagIconMap?: Map<string, string>
  onContentChange?: (blocks: Block[]) => void
  onMarkdownChange?: (markdown: string) => void
  onHeadingsChange?: (headings: HeadingInfo[]) => void
  /**
   * Reports the inline `#tags` in the body. `origin` separates the tag set the
   * note was OPENED with (`'load'`) from one the user just typed (`'edit'`):
   * opening a note must not modify it, so the load report is a baseline to diff
   * against and never something to persist (#1454).
   */
  onInlineTagsChange?: (tags: string[], origin: InlineTagsOrigin) => void
}

interface EditorSyncResult {
  handleChange: () => void
  /**
   * Run the debounced markdown save right now instead of waiting for its timer.
   * Used at teardown so an edit made inside the debounce window still persists
   * before the editor is destroyed. Resolves once `onMarkdownChange` has run.
   */
  flushPendingMarkdown: () => Promise<void>
  isContentReadyRef: React.RefObject<boolean>
  prevInlineTagsRef: React.MutableRefObject<string[]>
  lastNormalizedTagsRef: React.MutableRefObject<string>
}

export function useEditorSync({
  editor,
  noteId,
  notePath,
  initialContent,
  contentType = 'html',
  yjsFragment,
  externalContentRevision,
  isRemoteUpdateRef,
  noteTags,
  tagColorMap,
  tagIconMap,
  onContentChange,
  onMarkdownChange,
  onHeadingsChange,
  onInlineTagsChange
}: EditorSyncParams): EditorSyncResult {
  const loadedContentRevisionRef = useRef<number | null>(null)
  const isContentReadyRef = useRef(false)
  const prevInlineTagsRef = useRef<string[]>([])
  const lastNormalizedTagsRef = useRef<string>('')

  const markdownDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const headingsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inlineTagsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The debounced markdown save, kept callable so teardown can run it early.
  const pendingMarkdownSaveRef = useRef<(() => Promise<void>) | null>(null)
  // What the loaded markdown said and what the editor serialized it to, so a
  // save gives the author's spelling back wherever the document did not change
  // (#1915). Null for anything that did not load from markdown.
  const markdownSourceRef = useRef<MarkdownSourceRecord | null>(null)

  // Cleanup debounce timers on unmount
  useEffect(() => {
    return () => {
      if (markdownDebounceRef.current) clearTimeout(markdownDebounceRef.current)
      if (headingsDebounceRef.current) clearTimeout(headingsDebounceRef.current)
      if (inlineTagsDebounceRef.current) clearTimeout(inlineTagsDebounceRef.current)
    }
  }, [])

  useEffect(() => {
    if (!noteId) return

    activeNoteEditors.set(noteId, editor)
    return () => {
      if (activeNoteEditors.get(noteId) === editor) activeNoteEditors.delete(noteId)
    }
  }, [editor, noteId])

  // Parse content on initial mount (uncontrolled component pattern), and again
  // whenever the owner reports that `initialContent` was replaced from outside
  // this editor (`externalContentRevision`). Re-parsing in place is what lets
  // the owner keep one editor instance alive across external updates instead of
  // remounting a brand-new one.
  // Cancellation flag + cleanup return mark this as a synchronization effect
  // so the unnecessary-effect lints recognize it as legitimate.
  useEffect(() => {
    const revision = externalContentRevision ?? 0
    if (loadedContentRevisionRef.current === revision) {
      return
    }
    const isExternalReload = loadedContentRevisionRef.current !== null
    loadedContentRevisionRef.current = revision

    let cancelled = false

    /**
     * Report the tag set the note was opened with as the baseline for later
     * edits, without asking anyone to persist it. Opening a note must not
     * modify it (#1454), and every hash tag in the body reads as "new" until
     * this baseline exists.
     */
    const reportLoadedInlineTags = (): void => {
      if (!onInlineTagsChange) return
      const tags = extractInlineTags(editor.document as Block[])
      prevInlineTagsRef.current = tags
      onInlineTagsChange(tags, 'load')
    }

    // Collaboration owns the document: the main process feeds an external edit
    // into the shared Y.Doc (`feedExternalEditToCrdt`), the IPC provider applies
    // it here, and y-prosemirror merges it into this editor in place. Replacing
    // the blocks from `initialContent` would clobber that merge — including any
    // edit the user is making concurrently.
    if (isExternalReload && yjsFragment) {
      return
    }

    if (yjsFragment) {
      // Before the history is cleared, so opening a note never leaves an
      // undoable step: Cmd+Z here would turn the chips back into raw text and
      // push that to every device.
      promoteWikiLinksInSharedDoc(editor)
      promoteLinkMentionsInSharedDoc(editor)
      promoteInlineCheckboxesInSharedDoc(editor)
      promoteDateMentionsInSharedDoc(editor)
      clearYjsUndoHistory(editor)
      isContentReadyRef.current = true
      if (onHeadingsChange) {
        const headings = extractHeadings(editor.document as Block[])
        if (!cancelled) onHeadingsChange(headings)
      }
      // The shared fragment is already bound to the editor here (that is what
      // `extractHeadings` above reads), so this is the note's opening tag set.
      if (!cancelled) reportLoadedInlineTags()
      return () => {
        cancelled = true
      }
    }

    async function loadContent(): Promise<void> {
      let loadedSuccessfully = false
      markdownSourceRef.current = null
      try {
        if (typeof initialContent === 'string' && initialContent.trim()) {
          try {
            let content = initialContent

            if (contentType === 'markdown') {
              content = normalizeMarkdownHardBreaks(content)
            }

            let blocks
            if (contentType === 'markdown') {
              blocks = await parseMarkdownPreservingBlanks(editor, content, notePath)
            } else {
              blocks = await editor.tryParseHTMLToBlocks(content)
            }

            let normalizedBlocks = normalizeNoteBlocks(blocks)

            if (noteTags?.length && tagColorMap) {
              const tagSet = new Set(noteTags.map((t) => t.toLowerCase()))
              const hashNormalized = normalizeHashTags(
                normalizedBlocks,
                tagSet,
                tagColorMap,
                tagIconMap
              )
              normalizedBlocks = hashNormalized.blocks
              lastNormalizedTagsRef.current = noteTags.slice().sort().join(',')
            }

            normalizedBlocks = sanitizeBlockIds(normalizedBlocks)
            replaceInitialBlocksWithoutHistory(editor, normalizedBlocks)
            hydrateLinkMentionFavicons(editor)
            if (contentType === 'markdown') {
              markdownSourceRef.current = await recordLoadedMarkdownSource(editor, content)
            }
            loadedSuccessfully = true
          } catch (error) {
            // The user sees a blank/stale editor and thinks the note is gone.
            log.error(`Failed to parse ${contentType} content`, error)
            trackRendererError('editor_content_parse', error)
          }
        } else if (Array.isArray(initialContent) && initialContent.length > 0) {
          let normalizedBlocks = normalizeNoteBlocks(initialContent)

          if (noteTags?.length && tagColorMap) {
            const tagSet = new Set(noteTags.map((t) => t.toLowerCase()))
            const hashNormalized = normalizeHashTags(
              normalizedBlocks,
              tagSet,
              tagColorMap,
              tagIconMap
            )
            normalizedBlocks = hashNormalized.blocks
            lastNormalizedTagsRef.current = noteTags.slice().sort().join(',')
          }

          normalizedBlocks = sanitizeBlockIds(normalizedBlocks)
          replaceInitialBlocksWithoutHistory(editor, normalizedBlocks)
          hydrateLinkMentionFavicons(editor)
          loadedSuccessfully = true
        } else {
          loadedSuccessfully = true
        }
      } finally {
        if (loadedSuccessfully) {
          isContentReadyRef.current = true
        }
        if (!cancelled && loadedSuccessfully) {
          if (onHeadingsChange) {
            const headings = extractHeadings(editor.document as Block[])
            onHeadingsChange(headings)
          }
          reportLoadedInlineTags()
        }
      }
    }
    void loadContent()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, externalContentRevision])

  // Debounced change handler
  const handleChange = useCallback(() => {
    const blocks = editor.document

    // The block under the caret is exempt from wiki-link promotion while the
    // user is editing a link's raw `[[…]]` text — see `wiki-link-edit-plugin.ts`
    // and `NormalizeWikiLinksOptions`.
    const normalized = normalizeWikiLinks(blocks as Block[], {
      skipBlockId: editingWikiLinkBlockId(editor)
    })
    if (normalized.didChange) {
      editor.replaceBlocks(editor.document, normalized.blocks)
      return
    }

    onContentChange?.(blocks as Block[])

    if (isRemoteUpdateRef?.current) return

    // When Yjs collaboration is active, the main-process CRDT doc owns body
    // persistence and writes merged markdown back to disk. Avoid racing that
    // writeback with a separate renderer-triggered markdown save.
    if (!yjsFragment && onMarkdownChange && isContentReadyRef.current) {
      if (markdownDebounceRef.current) {
        clearTimeout(markdownDebounceRef.current)
      }
      const save = async (): Promise<void> => {
        pendingMarkdownSaveRef.current = null
        try {
          const markdown = await serializeMarkdownPreservingSource(
            editor,
            editor.document as Block[],
            markdownSourceRef.current,
            notePath
          )

          onMarkdownChange(markdown)
        } catch (error) {
          // The debounced save silently stops while the user keeps typing.
          log.error('Failed to convert blocks to markdown', error)
          trackRendererError('editor_serialize_save', error)
        }
      }
      pendingMarkdownSaveRef.current = save
      markdownDebounceRef.current = setTimeout(() => {
        markdownDebounceRef.current = null
        void save()
      }, 150)
    }

    if (onHeadingsChange) {
      if (headingsDebounceRef.current) {
        clearTimeout(headingsDebounceRef.current)
      }
      headingsDebounceRef.current = setTimeout(() => {
        const headings = extractHeadings(editor.document as Block[])
        onHeadingsChange(headings)
      }, 200)
    }

    if (onInlineTagsChange) {
      if (inlineTagsDebounceRef.current) clearTimeout(inlineTagsDebounceRef.current)
      inlineTagsDebounceRef.current = setTimeout(() => {
        const currentBlocks = editor.document as Block[]
        const tags = extractInlineTags(currentBlocks)
        const tagsKey = tags.sort().join(',')
        const prevKey = [...prevInlineTagsRef.current].sort().join(',')
        if (tagsKey !== prevKey) {
          prevInlineTagsRef.current = tags
          onInlineTagsChange(tags, 'edit')
        }
      }, 300)
    }
  }, [
    editor,
    onContentChange,
    isRemoteUpdateRef,
    yjsFragment,
    onMarkdownChange,
    notePath,
    onHeadingsChange,
    onInlineTagsChange
  ])

  // Teardown hook: run the debounced save now. The unmount cleanup above only
  // clears the timer, so without this an edit made in the last 150ms before the
  // tab/journal date closed would never reach `onMarkdownChange`.
  const flushPendingMarkdown = useCallback(async (): Promise<void> => {
    if (markdownDebounceRef.current) {
      clearTimeout(markdownDebounceRef.current)
      markdownDebounceRef.current = null
    }
    await pendingMarkdownSaveRef.current?.()
  }, [])

  return {
    handleChange,
    flushPendingMarkdown,
    isContentReadyRef,
    prevInlineTagsRef,
    lastNormalizedTagsRef
  }
}
