/**
 * Keeps the usage chips on a note's anchored blocks current: looks usage up
 * for the anchors the document carries, debounced, and again whenever
 * `portals:usage-changed` names this note.
 *
 * @module note/content-area/portal-flows/use-portal-usage-chips
 */

import { useEffect, useRef } from 'react'
import { useT } from '@memry/i18n/renderer'
import { createLogger } from '@/lib/logger'
import { registerEditorPlugin } from '../register-editor-plugin'
import { getPortalUsage, onPortalUsageChanged } from './portal-api'
import {
  PORTAL_USAGE_CHIP_KEY,
  createPortalUsageChipPlugin,
  usageCountsMeta
} from './portal-usage-chip-plugin'
import type { EditorSchema } from '../editor-schema'
import type { EditorView } from '@tiptap/pm/view'

const log = createLogger('PortalUsageChips')

const DOC_DEBOUNCE_MS = 500
const USAGE_DEBOUNCE_MS = 300

type Editor = EditorSchema['BlockNoteEditor']

function viewOf(editor: Editor): EditorView | undefined {
  return (editor as unknown as { prosemirrorView?: EditorView }).prosemirrorView
}

export function usePortalUsageChips(
  editor: Editor,
  noteId: string | undefined,
  onOpen: (anchor: string, chip: HTMLElement) => void
): void {
  const { t } = useT('notes')
  const labelRef = useRef((count: number) => t('portalFlows.usage.chipAria', { count }))
  labelRef.current = (count) => t('portalFlows.usage.chipAria', { count })
  const onOpenRef = useRef(onOpen)
  onOpenRef.current = onOpen

  useEffect(() => {
    if (!noteId) return
    const sourceNoteId = noteId

    const unregister = registerEditorPlugin(
      editor,
      createPortalUsageChipPlugin({
        label: (count) => labelRef.current(count),
        onOpen: (anchor, chip) => onOpenRef.current(anchor, chip)
      })
    )

    let lastKey: string | null = null
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let generation = 0

    const refresh = async (force: boolean): Promise<void> => {
      const view = viewOf(editor)
      const state = view ? PORTAL_USAGE_CHIP_KEY.getState(view.state) : undefined
      if (!view || !state) return
      const anchors = [...new Set(state.anchors)]
      const key = anchors.join(',')
      if (!force && key === lastKey) return
      lastKey = key

      const mine = ++generation
      const counts = new Map<string, number>()
      const settled = await Promise.allSettled(
        anchors.map(async (anchor) => {
          const hosts = await getPortalUsage(sourceNoteId, anchor)
          // Other notes only (main leaves the source's own portals out): each
          // portal and each linking note is one use.
          const total = hosts.reduce((sum, host) => sum + host.count, 0)
          if (total > 0) counts.set(anchor, total)
        })
      )
      // A newer lookup started while this one was in flight; its answer wins.
      if (disposed || mine !== generation) return
      const failed = settled.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') log.error('Portal usage lookup failed', failed.reason)
      const current = viewOf(editor)
      if (!current) return
      current.dispatch(current.state.tr.setMeta(...usageCountsMeta(counts)))
    }

    const schedule = (force: boolean, delay: number): void => {
      clearTimeout(timer)
      timer = setTimeout(() => void refresh(force), delay)
    }

    schedule(true, 0)
    const offChange = editor.onChange(() => schedule(false, DOC_DEBOUNCE_MS), true)
    let offUsage: (() => void) | undefined
    try {
      offUsage = onPortalUsageChanged((noteIds) => {
        // '*' is a change in `[[Note#^anchor]]` links, which name their target by text.
        if (noteIds.includes(sourceNoteId) || noteIds.includes('*'))
          schedule(true, USAGE_DEBOUNCE_MS)
      })
    } catch (err) {
      log.error('Cannot subscribe to portal usage changes', err)
    }

    return () => {
      disposed = true
      clearTimeout(timer)
      offChange?.()
      offUsage?.()
      unregister?.()
    }
  }, [editor, noteId])
}
