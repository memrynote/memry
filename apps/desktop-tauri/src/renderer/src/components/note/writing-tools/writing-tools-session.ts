/**
 * One note's writing tools: alternatives, ghosted ranges, the overflow list,
 * and the word count. The note page owns the session (its rail and
 * chrome read the snapshot); the editor attaches to it once it has a
 * ProseMirror view and the note's Y.Doc.
 *
 * Persistent records live in the Y.Doc side arrays (see
 * `@memry/shared` writing-tools/yjs.ts). The body only changes when the user
 * acts: picking a variant swaps the anchored text in place, Stash moves the selection into the overflow list.
 */

import { TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import type * as Y from 'yjs'
import {
  WRITING_ALTERNATIVES_ARRAY,
  WRITING_GHOSTS_ARRAY,
  WRITING_OVERFLOW_ARRAY,
  newWritingAlternativeId,
  readWritingAlternativesFromYDoc,
  readWritingGhostsFromYDoc,
  readWritingOverflowFromYDoc,
  writeWritingAlternativesToYDoc,
  writeWritingGhostsToYDoc,
  writeWritingOverflowToYDoc,
  type WritingAlternative,
  type WritingGhost,
  type WritingOverflowItem,
  type WritingVariant
} from '@memry/shared'
import type { WritingAssistInput, WritingAssistResult } from '@memry/contracts/writing-tools-api'
import { registerEditorPlugin } from '../content-area/register-editor-plugin'
import {
  anchorsForRange,
  createWritingToolsPlugin,
  isAlternativeRange,
  isStashableRange,
  writingToolsPluginKey,
  type AlternativeDisplay,
  type WritingRange,
  type WritingToolsMeta,
  type WritingToolsPluginState
} from './writing-tools-plugin'
import { newOverflowItem, renderOverflowHtml, stashHtml } from './overflow-html'
import { articleFixBefore } from './writing-text'

export type WritingRailMode = 'alternatives' | 'overflow'

export interface WritingAlternativeDraft {
  id: string
  original: string
}

export interface WritingToolsSnapshot {
  attached: boolean
  mode: WritingRailMode | null
  /** Alternatives that resolve in the editor, in document order */
  alternatives: WritingAlternative[]
  /** Tops relative to the `.marquee-zone`, by alternative id (and the draft id) */
  alternativeTops: Record<string, number>
  draft: WritingAlternativeDraft | null
  /** The card whose "Add alternative" input should take focus */
  focusAlternativeId: string | null
  hoveredAlternativeId: string | null
  /** Newest first */
  overflow: WritingOverflowItem[]
}

export type GenerateWritingAssist = (input: WritingAssistInput) => Promise<WritingAssistResult>

interface AttachOptions {
  /** A BlockNote editor; only its ProseMirror view is used. */
  editor: unknown
  doc: Y.Doc
  container: HTMLElement
}

interface DraftState extends WritingAlternativeDraft {
  anchorStart: WritingAlternative['anchorStart']
  anchorEnd: WritingAlternative['anchorEnd']
  from: number
}

const EMPTY_SNAPSHOT: WritingToolsSnapshot = {
  attached: false,
  mode: null,
  alternatives: [],
  alternativeTops: {},
  draft: null,
  focusAlternativeId: null,
  hoveredAlternativeId: null,
  overflow: []
}

/** Elements whose arrow keys are navigation, never alternative cycling. */
const ARROW_KEY_OWNERS =
  '[role="menu"], [role="menuitem"], [role="listbox"], [role="option"], .bn-suggestion-menu, .bn-grid-suggestion-menu'
/** Menus that take arrow keys while focus stays in the editor (BlockNote suggestions). */
const OPEN_MENUS = '[role="menu"], .bn-suggestion-menu, .bn-grid-suggestion-menu'

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}

function singleLine(text: string): string {
  return text.replace(/\s*\n+\s*/g, ' ').trim()
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function getLiveView(editor: unknown): EditorView | null {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- BlockNote exposes its tiptap editor only as an underscore field
  const tiptap = (editor as { _tiptapEditor?: { editorView?: EditorView; view?: EditorView } })
    ?._tiptapEditor
  // `view` on tiptap is a Proxy that is always truthy; `editorView` is the
  // real, nullable field (see live-prosemirror-view.ts).
  return tiptap?.editorView ? (tiptap.view ?? null) : null
}

export class WritingToolsSession {
  private snapshot: WritingToolsSnapshot = EMPTY_SNAPSHOT
  private readonly listeners = new Set<() => void>()
  private editor: unknown = null
  private doc: Y.Doc | null = null
  private container: HTMLElement | null = null
  private alternativeRecords: WritingAlternative[] = []
  private ghostRecords: WritingGhost[] = []
  private overflowRecords: WritingOverflowItem[] = []
  private draftState: DraftState | null = null
  private measureFrame: number | null = null
  /** Esc released the caret from this alternative; arrows move the caret until it leaves. */
  private escapedAlternativeId: string | null = null

  constructor(
    private readonly generateAssist: GenerateWritingAssist,
    private readonly formatHint: (position: number, total: number) => string,
    /**
     * Whether ⌘ (not Ctrl) is the shortcut modifier. Passed in rather than
     * imported: main's test program reaches this file through
     * content-area/types.ts, where the renderer's `@/` alias does not resolve.
     */
    private readonly platformIsMac: boolean
  ) {}

  // -------------------------------------------------------------------------
  // Store plumbing (useSyncExternalStore)
  // -------------------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): WritingToolsSnapshot => this.snapshot

  private patch(next: Partial<WritingToolsSnapshot>): void {
    const merged = { ...this.snapshot, ...next }
    if (sameJson(merged, this.snapshot)) return
    this.snapshot = merged
    for (const listener of this.listeners) listener()
  }

  private get view(): EditorView | null {
    return this.editor ? getLiveView(this.editor) : null
  }

  private get pluginState(): WritingToolsPluginState | null {
    const view = this.view
    return view ? (writingToolsPluginKey.getState(view.state) ?? null) : null
  }

  private dispatchMeta(meta: WritingToolsMeta): void {
    const view = this.view
    if (!view) return
    view.dispatch(view.state.tr.setMeta(writingToolsPluginKey, meta).setMeta('addToHistory', false))
  }

  // -------------------------------------------------------------------------
  // Attach / detach
  // -------------------------------------------------------------------------

  attach({ editor, doc, container }: AttachOptions): () => void {
    this.editor = editor
    this.doc = doc
    this.container = container
    this.readRecords()

    const plugin = createWritingToolsPlugin({
      getAlternatives: () =>
        this.alternativeRecords.map((record) => ({
          ...record,
          fallbackTexts: [this.shownTextOf(record), record.original],
          singleTextblock: true,
          knownTexts: [record.original, ...record.variants.map((variant) => variant.text)]
        })),
      getGhosts: () => this.ghostRecords,
      describeAlternative: (id, shownText) => this.describeAlternative(id, shownText),
      formatHint: this.formatHint,
      onViewUpdate: () => this.onViewUpdate()
    })
    const unregister = registerEditorPlugin(editor, plugin)

    const arrays = [WRITING_ALTERNATIVES_ARRAY, WRITING_GHOSTS_ARRAY, WRITING_OVERFLOW_ARRAY].map(
      (name) => doc.getArray(name)
    )
    const onRecordsChanged = (): void => {
      this.readRecords()
      this.dispatchMeta({ type: 'refresh' })
    }
    for (const array of arrays) array.observe(onRecordsChanged)

    container.addEventListener('pointerover', this.handlePointerOver)
    container.addEventListener('pointerout', this.handlePointerOut)
    container.addEventListener('keydown', this.handleEditorKeyDown, true)
    window.addEventListener('keydown', this.handleWindowKeyDown, true)

    this.patch({ attached: true })
    this.onViewUpdate()

    return () => {
      for (const array of arrays) array.unobserve(onRecordsChanged)
      container.removeEventListener('pointerover', this.handlePointerOver)
      container.removeEventListener('pointerout', this.handlePointerOut)
      container.removeEventListener('keydown', this.handleEditorKeyDown, true)
      window.removeEventListener('keydown', this.handleWindowKeyDown, true)
      unregister?.()
      if (this.measureFrame !== null) cancelAnimationFrame(this.measureFrame)
      this.measureFrame = null
      this.editor = null
      this.doc = null
      this.container = null
      this.draftState = null
      this.escapedAlternativeId = null
      this.snapshot = { ...EMPTY_SNAPSHOT, mode: this.snapshot.mode }
      for (const listener of this.listeners) listener()
    }
  }

  private readRecords(): void {
    const doc = this.doc
    if (!doc) return
    this.alternativeRecords = readWritingAlternativesFromYDoc(doc)
    this.ghostRecords = readWritingGhostsFromYDoc(doc)
    this.overflowRecords = readWritingOverflowFromYDoc(doc)
    this.patch({
      overflow: this.overflowRecords.toSorted((a, b) => b.createdAt - a.createdAt)
    })
  }

  // -------------------------------------------------------------------------
  // Derived state after each editor update
  // -------------------------------------------------------------------------

  private onViewUpdate(): void {
    const pluginState = this.pluginState
    if (!pluginState) return

    const byId = new Map(this.alternativeRecords.map((record) => [record.id, record]))
    const alternatives = pluginState.alternatives.flatMap((range) => {
      const record = byId.get(range.id)
      return record ? [record] : []
    })

    if (this.escapedAlternativeId) {
      const view = this.view
      if (!view || this.alternativeAtSelection(view) !== this.escapedAlternativeId) {
        this.escapedAlternativeId = null
      }
    }

    this.patch({
      alternatives,
      hoveredAlternativeId: pluginState.hoveredAlternativeId
    })
    this.scheduleMeasure()
  }

  private scheduleMeasure(): void {
    if (this.measureFrame !== null) return
    this.measureFrame = requestAnimationFrame(() => {
      this.measureFrame = null
      this.measure()
    })
  }

  private measure(): void {
    const view = this.view
    const pluginState = this.pluginState
    if (!view || !pluginState) return

    const next: Partial<WritingToolsSnapshot> = {}
    if (this.snapshot.mode === 'alternatives' && this.container) {
      const root = this.container.closest<HTMLElement>('.marquee-zone') ?? this.container
      const rootTop = root.getBoundingClientRect().top
      const tops: Record<string, number> = {}
      this.container
        .querySelectorAll<HTMLElement>('.writing-alt[data-writing-alt-id]')
        .forEach((el) => {
          const id = el.dataset.writingAltId
          if (!id || tops[id] !== undefined) return
          tops[id] = Math.max(0, el.getBoundingClientRect().top - rootTop)
        })
      const draft = this.draftState
      if (draft && draft.from <= view.state.doc.content.size) {
        try {
          tops[draft.id] = Math.max(0, view.coordsAtPos(draft.from).top - rootTop)
        } catch {
          // A position the view cannot measure keeps the card at the rail top.
        }
      }
      next.alternativeTops = tops
    }
    this.patch(next)
  }

  /** Re-measure after layout changes the session cannot see (rail opened, resize). */
  remeasure(): void {
    this.scheduleMeasure()
  }

  // -------------------------------------------------------------------------
  // Rail mode
  // -------------------------------------------------------------------------

  setMode(mode: WritingRailMode | null): void {
    this.patch({ mode })
    if (mode !== 'alternatives') this.cancelDraft()
    this.scheduleMeasure()
  }

  // -------------------------------------------------------------------------
  // Alternatives
  // -------------------------------------------------------------------------

  private rangeOf(kind: 'alternatives' | 'ghosts', id: string): WritingRange | null {
    return this.pluginState?.[kind].find((range) => range.id === id) ?? null
  }

  private shownTextOf(record: WritingAlternative): string {
    const active = record.variants.find((variant) => variant.id === record.activeVariantId)
    return active?.text ?? record.original
  }

  private describeAlternative(id: string, shownText: string): AlternativeDisplay | null {
    const record = this.alternativeRecords.find((alternative) => alternative.id === id)
    if (!record) return null
    const total = record.variants.length + 1
    // The body text decides, not `activeVariantId`: an undo can put the
    // original back without touching the record.
    if (shownText === record.original) return { active: false, position: 1, total }
    const byText = record.variants.findIndex((variant) => variant.text === shownText)
    if (byText !== -1) return { active: true, position: byText + 2, total }
    const byId = record.variants.findIndex((variant) => variant.id === record.activeVariantId)
    return byId === -1
      ? { active: false, position: 1, total }
      : { active: true, position: byId + 2, total }
  }

  /** The variant id shown in the body right now (null = original). */
  shownVariantId(record: WritingAlternative): string | null {
    const view = this.view
    const range = this.rangeOf('alternatives', record.id)
    if (!view || !range) return record.activeVariantId
    const display = this.describeAlternative(
      record.id,
      view.state.doc.textBetween(range.from, range.to, '\n', '\ufffc')
    )
    if (!display?.active) return null
    return record.variants[display.position - 2]?.id ?? null
  }

  private writeAlternatives(next: WritingAlternative[]): void {
    if (!this.doc) return
    writeWritingAlternativesToYDoc(this.doc, next)
  }

  private updateAlternative(
    id: string,
    update: (record: WritingAlternative) => WritingAlternative | null
  ): void {
    const next = this.alternativeRecords.flatMap((record) => {
      if (record.id !== id) return [record]
      const updated = update(record)
      return updated && updated.variants.length > 0 ? [updated] : []
    })
    this.writeAlternatives(next)
  }

  /**
   * Replace the alternative's text in the body with `text`, fixing a leading
   * "a"/"an" to agree with it, and re-anchor the record on the new text.
   */
  private showText(id: string, text: string, activeVariantId: string | null): boolean {
    const view = this.view
    const range = this.rangeOf('alternatives', id)
    if (!view || !range) return false

    const { state } = view
    const blockStart = state.doc.resolve(range.from).start()
    const before = state.doc.textBetween(blockStart, range.from, undefined, '\ufffc')
    const fix = articleFixBefore(before, text)
    const tr = state.tr.insertText(text, range.from, range.to)
    let from = range.from
    if (fix) {
      tr.insertText(fix.replacement, blockStart + fix.start, blockStart + fix.end)
      from += fix.replacement.length - (fix.end - fix.start)
    }
    view.dispatch(tr)

    // The dispatch above has already reached the Y.Doc (y-prosemirror syncs
    // in the same view update), so anchors taken now point at the new text.
    const anchors = anchorsForRange(view.state, from, from + text.length)
    this.updateAlternative(id, (record) => ({
      ...record,
      ...anchors,
      activeVariantId
    }))
    return true
  }

  activateVariant(id: string, variantId: string | null): void {
    const record = this.alternativeRecords.find((alternative) => alternative.id === id)
    if (!record) return
    const variant = record.variants.find((candidate) => candidate.id === variantId)
    this.showText(id, variant?.text ?? record.original, variant?.id ?? null)
  }

  /** Arrow-key cycling: original -> variants -> original. */
  cycleAlternative(id: string, direction: 1 | -1): boolean {
    const record = this.alternativeRecords.find((alternative) => alternative.id === id)
    const view = this.view
    const range = this.rangeOf('alternatives', id)
    if (!record || !view || !range) return false
    const display = this.describeAlternative(
      id,
      view.state.doc.textBetween(range.from, range.to, '\n', '\ufffc')
    )
    if (!display) return false
    const nextIndex = (display.position - 1 + direction + display.total) % display.total
    const variant = nextIndex === 0 ? null : record.variants[nextIndex - 1]
    return this.showText(id, variant?.text ?? record.original, variant?.id ?? null)
  }

  addVariant(id: string, rawText: string): void {
    const text = singleLine(rawText)
    if (!text) return
    const variant: WritingVariant = {
      id: newId('var'),
      text,
      source: 'user',
      createdAt: Date.now()
    }
    this.updateAlternative(id, (record) =>
      record.original === text || record.variants.some((existing) => existing.text === text)
        ? record
        : { ...record, variants: [...record.variants, variant] }
    )
  }

  removeVariant(id: string, variantId: string): void {
    const record = this.alternativeRecords.find((alternative) => alternative.id === id)
    if (!record) return
    if (this.shownVariantId(record) === variantId) this.showText(id, record.original, null)
    this.updateAlternative(id, (current) => ({
      ...current,
      activeVariantId: current.activeVariantId === variantId ? null : current.activeVariantId,
      variants: current.variants.filter((variant) => variant.id !== variantId)
    }))
  }

  removeAiVariants(id: string): void {
    const record = this.alternativeRecords.find((alternative) => alternative.id === id)
    if (!record) return
    const shown = record.variants.find((variant) => variant.id === this.shownVariantId(record))
    if (shown?.source === 'ai') this.showText(id, record.original, null)
    this.updateAlternative(id, (current) => {
      const variants = current.variants.filter((variant) => variant.source !== 'ai')
      return {
        ...current,
        variants,
        activeVariantId: variants.some((variant) => variant.id === current.activeVariantId)
          ? current.activeVariantId
          : null
      }
    })
  }

  /** The alternative whose range overlaps [from, to], or contains `from` when empty. */
  alternativeAt(from: number, to = from): string | null {
    const ranges = this.pluginState?.alternatives ?? []
    const hit = ranges.find((range) =>
      from === to ? range.from <= from && from <= range.to : range.from < to && from < range.to
    )
    return hit?.id ?? null
  }

  /**
   * "Add alternative" on a selection: focus the card of the alternative it
   * touches, or open a draft card for a new one. Nothing is stored until the
   * first variant is entered.
   */
  startAlternative(from: number, to: number): boolean {
    const view = this.view
    if (!view) return false
    const existing = this.alternativeAt(from, to)
    if (existing) {
      this.cancelDraft()
      this.patch({ focusAlternativeId: existing })
      this.setMode('alternatives')
      return true
    }
    if (!isAlternativeRange(view, from, to)) return false
    const anchors = anchorsForRange(view.state, from, to)
    if (!anchors) return false
    this.draftState = {
      id: newId('alt-draft'),
      original: view.state.doc.textBetween(from, to),
      from,
      ...anchors
    }
    this.patch({
      draft: { id: this.draftState.id, original: this.draftState.original },
      focusAlternativeId: this.draftState.id
    })
    this.setMode('alternatives')
    return true
  }

  submitDraft(rawText: string): void {
    const draft = this.draftState
    const text = singleLine(rawText)
    if (!draft || !text || text === draft.original) return
    const record: WritingAlternative = {
      id: newWritingAlternativeId(),
      anchorStart: draft.anchorStart,
      anchorEnd: draft.anchorEnd,
      original: draft.original,
      variants: [{ id: newId('var'), text, source: 'user', createdAt: Date.now() }],
      activeVariantId: null
    }
    this.draftState = null
    this.patch({ draft: null, focusAlternativeId: record.id })
    this.writeAlternatives([...this.alternativeRecords, record])
  }

  cancelDraft(): void {
    if (!this.draftState) return
    this.draftState = null
    this.patch({ draft: null })
  }

  clearFocusAlternative(): void {
    this.patch({ focusAlternativeId: null })
  }

  hoverAlternative(id: string | null): void {
    if (this.pluginState?.hoveredAlternativeId === id) return
    this.dispatchMeta({ type: 'hover', id })
  }

  /**
   * "Suggest alternatives": ask the model for wordings of the selection and
   * add them as AI variants, to the alternative the selection touches or to a
   * new one. Resolves to the number of variants added.
   */
  async suggestAlternatives(from: number, to: number): Promise<number> {
    const view = this.view
    if (!view) return 0
    const existingId = this.alternativeAt(from, to)
    const existing = this.alternativeRecords.find((alternative) => alternative.id === existingId)
    const range = existing ? this.rangeOf('alternatives', existing.id) : { from, to }
    if (!range || (!existing && !isAlternativeRange(view, from, to))) return 0

    const anchors = existing ? null : anchorsForRange(view.state, from, to)
    if (!existing && !anchors) return 0
    const original = existing?.original ?? view.state.doc.textBetween(from, to)
    const $from = view.state.doc.resolve(range.from)
    const context = $from.parent.textBetween(0, $from.parent.content.size, undefined, ' ')

    // The page keeps one session across notes. If the editor moved on to
    // another note's doc while the model answered, these anchors and this
    // text belong to a doc that is no longer attached.
    const doc = this.doc
    const result = await this.generateAssist({ kind: 'alternatives', text: original, context })
    if (result.kind !== 'alternatives' || !doc || this.doc !== doc) return 0

    const latest = existing
      ? this.alternativeRecords.find((alternative) => alternative.id === existing.id)
      : null
    const taken = new Set([original, ...(latest?.variants.map((variant) => variant.text) ?? [])])
    const now = Date.now()
    const added: WritingVariant[] = []
    for (const text of result.alternatives.map(singleLine)) {
      if (!text || taken.has(text)) continue
      taken.add(text)
      added.push({ id: newId('var'), text, source: 'ai', createdAt: now })
    }
    if (added.length === 0 || (existing && !latest)) return 0

    if (latest) {
      this.updateAlternative(latest.id, (record) => ({
        ...record,
        variants: [...record.variants, ...added]
      }))
      this.patch({ focusAlternativeId: latest.id })
    } else if (anchors) {
      const record: WritingAlternative = {
        id: newWritingAlternativeId(),
        ...anchors,
        original,
        variants: added,
        activeVariantId: null
      }
      this.writeAlternatives([...this.alternativeRecords, record])
      this.patch({ focusAlternativeId: record.id })
    }
    this.setMode('alternatives')
    return added.length
  }

  // -------------------------------------------------------------------------
  // Ghosts
  // -------------------------------------------------------------------------

  /** The ghost containing `pos`, or overlapping [pos, to]. */
  ghostAt(pos: number, to = pos): string | null {
    const ranges = this.pluginState?.ghosts ?? []
    const hit = ranges.find((range) =>
      pos === to ? range.from <= pos && pos < range.to : range.from < to && pos < range.to
    )
    return hit?.id ?? null
  }

  ghost(from: number, to: number): boolean {
    const view = this.view
    if (!view || !this.doc || to <= from) return false
    const anchors = anchorsForRange(view.state, from, to)
    if (!anchors) return false
    writeWritingGhostsToYDoc(this.doc, [...this.ghostRecords, { id: newId('ghost'), ...anchors }])
    return true
  }

  revive(ghostId: string): void {
    if (!this.doc) return
    writeWritingGhostsToYDoc(
      this.doc,
      this.ghostRecords.filter((ghost) => ghost.id !== ghostId)
    )
  }

  // -------------------------------------------------------------------------
  // Overflow
  // -------------------------------------------------------------------------

  addOverflow(rawText: string, label?: string, html?: string): void {
    const item = newOverflowItem(newId('overflow'), rawText, html, label)
    if (this.doc && item) writeWritingOverflowToYDoc(this.doc, [...this.overflowRecords, item])
  }

  /** An overflow item rendered for the rail; see `renderOverflowHtml`. */
  renderOverflow(item: WritingOverflowItem): HTMLElement | DocumentFragment | null {
    return this.view && item.html ? renderOverflowHtml(this.view.state.schema, item.html) : null
  }

  removeOverflow(id: string): void {
    if (!this.doc) return
    writeWritingOverflowToYDoc(
      this.doc,
      this.overflowRecords.filter((item) => item.id !== id)
    )
  }

  /** "Stash in overflow": the selection leaves the body for the overflow list. */
  stash(from: number, to: number): boolean {
    const view = this.view
    if (!view || !this.doc || !isStashableRange(view.state.doc, from, to)) return false
    const text = view.state.doc.textBetween(from, to, '\n', '')
    const html = stashHtml(view, from, to)
    view.dispatch(view.state.tr.delete(from, to).scrollIntoView())
    this.addOverflow(text, undefined, html)
    this.setMode('overflow')
    return true
  }

  // -------------------------------------------------------------------------
  // DOM events
  // -------------------------------------------------------------------------

  private handlePointerOver = (event: PointerEvent): void => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- DOM event targets are typed EventTarget; this handler is bound to elements, so the target is the Element/Node
    const target = event.target as HTMLElement | null
    const element = target?.closest<HTMLElement>('[data-writing-alt-id]')
    if (element?.dataset.writingAltId) this.hoverAlternative(element.dataset.writingAltId)
  }

  private handlePointerOut = (event: PointerEvent): void => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- DOM event targets are typed EventTarget; this handler is bound to elements, so the target is the Element/Node
    const target = event.target as HTMLElement | null
    const element = target?.closest<HTMLElement>('[data-writing-alt-id]')
    if (!element) return
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- DOM event targets are typed EventTarget; this handler is bound to elements, so the target is the Element/Node
    const related = (event.relatedTarget as HTMLElement | null)?.closest<HTMLElement>(
      '[data-writing-alt-id]'
    )
    if (related?.dataset.writingAltId === element.dataset.writingAltId) return
    this.hoverAlternative(null)
  }

  /** ⌥⌘A (Ctrl+Alt+A elsewhere): Add alternative for the selection. */
  private handleEditorKeyDown = (event: KeyboardEvent): void => {
    const mod = this.platformIsMac ? event.metaKey : event.ctrlKey
    if (!mod || !event.altKey || event.shiftKey || event.code !== 'KeyA') return
    const view = this.view
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- DOM event targets are typed EventTarget; this handler is bound to elements, so the target is the Element/Node
    if (!view || !view.dom.contains(event.target as Node)) return
    const { from, to, empty } = view.state.selection
    if (empty && !this.alternativeAt(from)) return
    event.preventDefault()
    event.stopPropagation()
    this.startAlternative(from, to)
  }

  /**
   * ↑/↓ cycle an alternative whenever the caret (or selection) is in it,
   * touching either edge included, so the arrows never leave the user stuck
   * on it. Esc releases the caret from that alternative: arrows move the
   * caret normally until it has left the word. With focus outside the
   * editor, the hovered alternative is cycled instead. Owned at the window,
   * in capture, for that case. Menus keep their own arrow keys.
   */
  private handleWindowKeyDown = (event: KeyboardEvent): void => {
    const isEscape = event.key === 'Escape'
    if (!isEscape && event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    const view = this.view
    if (!view) return
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest(ARROW_KEY_OWNERS)) return
    if (document.querySelector(OPEN_MENUS)) return

    let id: string | null
    if (target && view.dom.contains(target)) {
      id = this.alternativeAtSelection(view)
    } else if (
      !isEscape &&
      (!target || target === document.body || target === document.documentElement)
    ) {
      id = this.pluginState?.hoveredAlternativeId ?? null
    } else {
      return
    }
    if (!id || id === this.escapedAlternativeId) return

    if (isEscape) {
      // Not consumed: Esc keeps its other jobs.
      this.escapedAlternativeId = id
      return
    }
    if (!this.cycleAlternative(id, event.key === 'ArrowDown' ? 1 : -1)) return
    event.preventDefault()
    event.stopPropagation()
    this.keepCaretIn(view, id)
  }

  /** The alternative holding the whole selection, edges included. */
  private alternativeAtSelection(view: EditorView): string | null {
    const { from, to } = view.state.selection
    const hit = this.pluginState?.alternatives.find((range) => range.from <= from && to <= range.to)
    return hit?.id ?? null
  }

  /** A swap can map the caret just outside the new text; pull it back to the end. */
  private keepCaretIn(view: EditorView, id: string): void {
    const range = this.rangeOf('alternatives', id)
    if (!range || !view.hasFocus()) return
    const { from, to } = view.state.selection
    if (range.from <= from && to <= range.to) return
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, range.to)))
  }
}
