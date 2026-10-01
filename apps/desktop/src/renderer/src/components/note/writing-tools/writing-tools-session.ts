/**
 * One note's writing tools: alternatives, ghosted ranges, the overflow list,
 * the word count and the AI Lab. The note page owns the session (its rail and
 * chrome read the snapshot); the editor attaches to it once it has a
 * ProseMirror view and the note's Y.Doc.
 *
 * Persistent records live in the Y.Doc side arrays (see
 * `@memry/shared` writing-tools/yjs.ts). The body only changes when the user
 * acts: picking a variant swaps the anchored text in place, Cut deletes a trim
 * suggestion, Stash moves the selection into the overflow list.
 */

import { TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import type * as Y from 'yjs'
import {
  WRITING_ALTERNATIVES_ARRAY,
  WRITING_GHOSTS_ARRAY,
  WRITING_OVERFLOW_ARRAY,
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
import type {
  WritingAssistInput,
  WritingAssistResult,
  WritingCheckKind,
  WritingTrimLevel
} from '@memry/contracts/writing-tools-api'
import { registerEditorPlugin } from '../content-area/register-editor-plugin'
import {
  anchorsForRange,
  collectTextBlocks,
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
import { articleFixBefore, countWordsExcluding, cutSpacing, findQuoteRanges } from './writing-text'

export type WritingRailMode = 'alternatives' | 'overflow' | 'lab'

export interface LabFlag {
  id: string
  check: WritingCheckKind
  quote: string
  reason: string
}

export type LabRun = WritingCheckKind | WritingTrimLevel

export interface WritingTrimReview {
  level: WritingTrimLevel
  /** Remaining suggestions, in document order */
  ids: string[]
  focusedIndex: number
}

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
  wordCount: number
  lab: {
    running: LabRun | null
    flags: LabFlag[]
    focusedFlagId: string | null
    trim: WritingTrimReview | null
  }
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
  overflow: [],
  wordCount: 0,
  lab: { running: null, flags: [], focusedFlagId: null, trim: null }
}

/** Elements whose arrow keys are navigation, never alternative cycling. */
const ARROW_KEY_OWNERS =
  '[role="menu"], [role="menuitem"], [role="listbox"], [role="option"], .bn-suggestion-menu, .bn-grid-suggestion-menu'
/** Menus that take arrow keys while focus stays in the editor (BlockNote suggestions). */
const OPEN_MENUS = '[role="menu"], .bn-suggestion-menu, .bn-grid-suggestion-menu'

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}

/**
 * An alternative's id is written into the note file (`<!--alt:k3x9q2xm-->`),
 * so it is kept short. Eight base-36 characters; a clash within one note is
 * negligible, and the parser keeps the first range if one ever happens.
 */
function newAlternativeId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(bytes, (byte) => (byte % 36).toString(36)).join('')
}

function singleLine(text: string): string {
  return text.replace(/\s*\n+\s*/g, ' ').trim()
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function getLiveView(editor: unknown): EditorView | null {
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
  private flagDetails = new Map<string, LabFlag>()
  private trimLevel: WritingTrimLevel | null = null
  private wordCountEnabled = false
  private measureFrame: number | null = null
  private labRequest = 0

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

  private patchLab(next: Partial<WritingToolsSnapshot['lab']>): void {
    this.patch({ lab: { ...this.snapshot.lab, ...next } })
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
      this.flagDetails.clear()
      this.trimLevel = null
      this.labRequest++
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
      overflow: [...this.overflowRecords].sort((a, b) => b.createdAt - a.createdAt)
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

    const flags = pluginState.flags.flatMap((range) => {
      const flag = this.flagDetails.get(range.id)
      return flag ? [flag] : []
    })

    let trim: WritingTrimReview | null = null
    if (this.trimLevel && pluginState.trims.length > 0) {
      const ids = pluginState.trims.map((range) => range.id)
      const focused = pluginState.focusedTrimId ? ids.indexOf(pluginState.focusedTrimId) : -1
      trim = { level: this.trimLevel, ids, focusedIndex: Math.max(0, focused) }
    } else if (this.trimLevel && pluginState.trims.length === 0) {
      this.trimLevel = null
    }

    this.patch({
      alternatives,
      hoveredAlternativeId: pluginState.hoveredAlternativeId,
      lab: { ...this.snapshot.lab, flags, focusedFlagId: pluginState.focusedFlagId, trim }
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
    if (this.wordCountEnabled) {
      next.wordCount = countWordsExcluding(collectTextBlocks(view.state.doc), pluginState.ghosts)
    }

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

  setWordCountEnabled(enabled: boolean): void {
    this.wordCountEnabled = enabled
    if (enabled) this.scheduleMeasure()
  }

  // -------------------------------------------------------------------------
  // Rail mode
  // -------------------------------------------------------------------------

  setMode(mode: WritingRailMode | null): void {
    // Lab results are transient: closing the Lab takes its flags and cuts away.
    if (this.snapshot.mode === 'lab' && mode !== 'lab') {
      this.stopTrim()
      if (this.snapshot.lab.flags.length > 0) this.clearFlags()
    }
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
      ...(anchors ?? {}),
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
      id: newAlternativeId(),
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
        id: newAlternativeId(),
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
  // Lab
  // -------------------------------------------------------------------------

  private documentText(): string {
    const view = this.view
    if (!view) return ''
    return collectTextBlocks(view.state.doc)
      .map((block) => block.text.replace(/\ufffc/g, ' '))
      .filter((text) => text.trim().length > 0)
      .join('\n\n')
  }

  /** Resolves to the number of findings placed in the note; null for an empty note. */
  async runCheck(check: WritingCheckKind): Promise<number | null> {
    const markdown = this.documentText()
    if (!markdown.trim()) return null
    const request = ++this.labRequest
    this.patchLab({ running: check })
    try {
      const result = await this.generateAssist({ kind: 'check', check, markdown })
      const view = this.view
      if (request !== this.labRequest || !view || result.kind !== 'check') return 0
      const ranges = findQuoteRanges(
        collectTextBlocks(view.state.doc),
        result.findings.map((finding) => finding.quote)
      )
      this.flagDetails.clear()
      const flags = ranges.map((range) => {
        const finding = result.findings[range.index]
        const flag: LabFlag = {
          id: newId('flag'),
          check,
          quote: finding.quote,
          reason: finding.reason
        }
        this.flagDetails.set(flag.id, flag)
        return { id: flag.id, from: range.from, to: range.to }
      })
      this.dispatchMeta({ type: 'setFlags', flags: flags.sort((a, b) => a.from - b.from) })
      return flags.length
    } finally {
      if (request === this.labRequest) this.patchLab({ running: null })
    }
  }

  focusFlag(id: string): void {
    const view = this.view
    const range = this.pluginState?.flags.find((flag) => flag.id === id)
    if (!view || !range) return
    view.dispatch(
      view.state.tr
        .setSelection(TextSelection.create(view.state.doc, range.from, range.to))
        .setMeta(writingToolsPluginKey, { type: 'focusFlag', id } satisfies WritingToolsMeta)
        .scrollIntoView()
    )
    view.focus()
  }

  clearFlags(): void {
    this.flagDetails.clear()
    this.dispatchMeta({ type: 'setFlags', flags: [] })
  }

  /**
   * Resolves to the number of cuts proposed; null for an empty note. Replaces
   * any suggestions on screen.
   */
  async runTrim(level: WritingTrimLevel): Promise<number | null> {
    const markdown = this.documentText()
    if (!markdown.trim()) return null
    const request = ++this.labRequest
    this.patchLab({ running: level })
    try {
      const result = await this.generateAssist({ kind: 'trim', level, markdown })
      const view = this.view
      if (request !== this.labRequest || !view || result.kind !== 'trim') return 0
      const trims = findQuoteRanges(
        collectTextBlocks(view.state.doc),
        result.cuts.map((cut) => cut.quote)
      )
        .map((range) => ({ id: newId('trim'), from: range.from, to: range.to }))
        .sort((a, b) => a.from - b.from)
      this.trimLevel = trims.length > 0 ? level : null
      this.dispatchMeta({ type: 'setTrims', trims, focusedId: trims[0]?.id ?? null })
      if (trims[0]) this.scrollToRange(trims[0])
      return trims.length
    } finally {
      if (request === this.labRequest) this.patchLab({ running: null })
    }
  }

  private scrollToRange(range: { from: number; to: number }): void {
    const view = this.view
    if (!view) return
    try {
      const { node } = view.domAtPos(range.from)
      const element = node instanceof HTMLElement ? node : node.parentElement
      element?.scrollIntoView({ block: 'center', behavior: 'auto' })
    } catch {
      // Nothing to scroll to.
    }
  }

  /** A trim range widened by the one space that would otherwise be left doubled. */
  private cutRange(view: EditorView, range: WritingRange): { from: number; to: number } {
    const { doc } = view.state
    const charBefore = range.from > 1 ? doc.textBetween(range.from - 1, range.from, '', '') : ''
    const charAfter =
      range.to < doc.content.size ? doc.textBetween(range.to, range.to + 1, '', '') : ''
    switch (cutSpacing(charBefore, charAfter)) {
      case 'before':
        return { from: range.from - 1, to: range.to }
      case 'after':
        return { from: range.from, to: range.to + 1 }
      default:
        return { from: range.from, to: range.to }
    }
  }

  private trimRanges(): WritingRange[] {
    return this.pluginState?.trims ?? []
  }

  focusTrim(direction: 1 | -1): void {
    const trims = this.trimRanges()
    if (trims.length === 0) return
    const current = trims.findIndex((range) => range.id === this.pluginState?.focusedTrimId)
    const next = trims[(Math.max(0, current) + direction + trims.length) % trims.length]
    this.dispatchMeta({ type: 'focusTrim', id: next.id })
    this.scrollToRange(next)
  }

  /** Keep the focused text: drop the suggestion, move to the next one. */
  keepTrim(): void {
    this.settleFocusedTrim(false)
  }

  /** Cut the focused suggestion from the body, move to the next one. */
  cutTrim(): void {
    this.settleFocusedTrim(true)
  }

  private settleFocusedTrim(cut: boolean): void {
    const view = this.view
    const trims = this.trimRanges()
    const index = trims.findIndex((range) => range.id === this.pluginState?.focusedTrimId)
    if (!view || index === -1) return
    const focused = trims[index]
    const remaining = trims.filter((range) => range.id !== focused.id)
    const nextFocus = remaining[Math.min(index, remaining.length - 1)] ?? null
    const meta: WritingToolsMeta = {
      type: 'setTrims',
      trims: remaining,
      focusedId: nextFocus?.id ?? null
    }
    // The meta's ranges are pre-cut positions, so the cut goes in a separate
    // transaction that the plugin maps them through.
    this.dispatchMeta(meta)
    if (cut) {
      const range = this.cutRange(view, focused)
      view.dispatch(view.state.tr.delete(range.from, range.to))
    }
    if (nextFocus) {
      const mapped = this.trimRanges().find((range) => range.id === nextFocus.id)
      if (mapped) this.scrollToRange(mapped)
    }
  }

  cutAllTrims(): void {
    const view = this.view
    const trims = this.trimRanges()
    if (!view || trims.length === 0) return
    const tr = view.state.tr
    // Back to front, so earlier positions stay valid. Suggestions never
    // overlap (quotes are matched to distinct spans), but two can share the
    // one space between them, so each cut is clamped to the previous start.
    let limit = view.state.doc.content.size
    for (const trim of [...trims].sort((a, b) => b.from - a.from)) {
      const range = this.cutRange(view, trim)
      const to = Math.min(range.to, limit)
      if (to > range.from) tr.delete(range.from, to)
      limit = range.from
    }
    tr.setMeta(writingToolsPluginKey, { type: 'setTrims', trims: [], focusedId: null })
    view.dispatch(tr)
    this.trimLevel = null
  }

  stopTrim(): void {
    this.labRequest++
    this.trimLevel = null
    this.patchLab({ running: null })
    this.dispatchMeta({ type: 'setTrims', trims: [], focusedId: null })
  }

  // -------------------------------------------------------------------------
  // DOM events
  // -------------------------------------------------------------------------

  private handlePointerOver = (event: PointerEvent): void => {
    const target = event.target as HTMLElement | null
    const element = target?.closest<HTMLElement>('[data-writing-alt-id]')
    if (element?.dataset.writingAltId) this.hoverAlternative(element.dataset.writingAltId)
  }

  private handlePointerOut = (event: PointerEvent): void => {
    const target = event.target as HTMLElement | null
    const element = target?.closest<HTMLElement>('[data-writing-alt-id]')
    if (!element) return
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
    if (!view || !view.dom.contains(event.target as Node)) return
    const { from, to, empty } = view.state.selection
    if (empty && !this.alternativeAt(from)) return
    event.preventDefault()
    event.stopPropagation()
    this.startAlternative(from, to)
  }

  /**
   * ↑/↓ over a hovered alternative cycles it. Owned at the window, in capture,
   * because the editor need not have focus while the pointer rests on the
   * text. Arrow keys stay caret movement and menu navigation everywhere else:
   * inside the editor the caret has to be in or touching the hovered range,
   * outside it nothing may hold focus, and any open menu keeps its keys.
   */
  private handleWindowKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    const view = this.view
    const hovered = this.pluginState?.hoveredAlternativeId
    if (!view || !hovered) return
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest(ARROW_KEY_OWNERS)) return
    if (document.querySelector(OPEN_MENUS)) return

    if (target && view.dom.contains(target)) {
      const { selection } = view.state
      const range = this.rangeOf('alternatives', hovered)
      if (!selection.empty || !range) return
      if (selection.from < range.from || selection.from > range.to) return
    } else if (target && target !== document.body && target !== document.documentElement) {
      return
    }

    if (this.cycleAlternative(hovered, event.key === 'ArrowDown' ? 1 : -1)) {
      event.preventDefault()
      event.stopPropagation()
    }
  }
}
