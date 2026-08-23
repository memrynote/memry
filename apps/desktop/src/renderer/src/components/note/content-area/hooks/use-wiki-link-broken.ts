/**
 * Broken wiki-link detection for one mounted editor (#1716).
 *
 * On mount — and debounced on every document change, since notes load their
 * content asynchronously after the editor exists — the document's wiki targets
 * are deduped and resolved in ONE batch IPC call (`notes:resolve-titles`).
 * Targets that resolve to nothing become the plugin's broken set, painted as
 * `.wiki-link-broken` (see `wiki-link-broken-plugin.ts`).
 *
 * Resolution order per target matches the click path: the note half of
 * `[[Note#Heading]]` first, the raw string second — so a note literally named
 * `Sprint #4` is not marked broken. `[[#Heading]]` addresses the note it is
 * written in and is never broken here; heading-level misses keep today's
 * behavior by design.
 *
 * Titles resolve through a session cache so a keystroke only re-asks about
 * titles it has not seen. A note being created, renamed, or deleted anywhere
 * (this window or another device) drops the cache and re-resolves, which is
 * what restyles an open editor without a reload.
 */

import { useEffect } from 'react'
import type { EditorView } from '@tiptap/pm/view'
import { splitWikiTarget } from '@memry/shared/wiki-target'
import { notesService, onNoteCreated, onNoteDeleted, onNoteRenamed } from '@/services/notes-service'
import { registerEditorPlugin } from '../register-editor-plugin'
import {
  collectWikiLinkTargets,
  createWikiLinkBrokenPlugin,
  setBrokenWikiTargets
} from '../wiki-link-broken-plugin'

const REFRESH_DEBOUNCE_MS = 400

interface TiptapLike {
  view?: EditorView
  on?: (event: string, handler: () => void) => void
  off?: (event: string, handler: () => void) => void
}

export function useWikiLinkBroken(editor: unknown): void {
  useEffect(() => registerEditorPlugin(editor, createWikiLinkBrokenPlugin()), [editor])

  useEffect(() => {
    const tiptap = (editor as { _tiptapEditor?: TiptapLike } | undefined)?._tiptapEditor
    if (!tiptap?.on || !tiptap?.off) return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    /** Lowercased title → whether it resolved. Session-scoped; note events clear it. */
    const resolvedCache = new Map<string, boolean>()
    let lastBroken = new Set<string>()

    const refresh = async (): Promise<void> => {
      const view = tiptap.view
      if (!view || cancelled) return

      // Raw target → the titles whose resolution decides its brokenness.
      const perTarget = new Map<string, string[]>()
      for (const target of collectWikiLinkTargets(view.state.doc)) {
        const { note, heading } = splitWikiTarget(target)
        if (heading !== null && !note) continue
        perTarget.set(target, heading !== null && note ? [note, target] : [target])
      }

      const unknown: string[] = []
      const queued = new Set<string>()
      for (const candidates of perTarget.values()) {
        for (const title of candidates) {
          const key = title.toLowerCase()
          if (resolvedCache.has(key) || queued.has(key)) continue
          queued.add(key)
          unknown.push(title)
        }
      }

      if (unknown.length > 0) {
        try {
          const resolved = await notesService.resolveTitles(unknown)
          for (const title of unknown) {
            resolvedCache.set(title.toLowerCase(), resolved[title] != null)
          }
        } catch {
          // IPC failed — keep the current styling rather than guessing.
          return
        }
        if (cancelled) return
      }

      const broken = new Set<string>()
      for (const [target, candidates] of perTarget) {
        const resolves = candidates.some((title) => resolvedCache.get(title.toLowerCase()) === true)
        if (!resolves) broken.add(target.toLowerCase())
      }

      // Unchanged set → no dispatch: this runs behind every keystroke.
      if (broken.size === lastBroken.size && [...broken].every((key) => lastBroken.has(key))) {
        return
      }
      lastBroken = broken
      const liveView = tiptap.view
      if (liveView) setBrokenWikiTargets(liveView, broken)
    }

    const scheduleRefresh = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void refresh(), REFRESH_DEBOUNCE_MS)
    }

    const forceRefresh = (): void => {
      resolvedCache.clear()
      scheduleRefresh()
    }

    void refresh()
    tiptap.on('update', scheduleRefresh)
    const unsubscribes = [
      onNoteCreated(forceRefresh),
      onNoteRenamed(forceRefresh),
      onNoteDeleted(forceRefresh)
    ]

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      tiptap.off?.('update', scheduleRefresh)
      unsubscribes.forEach((unsubscribe) => unsubscribe())
    }
  }, [editor])
}
