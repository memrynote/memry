/**
 * Puts the window plugin on the editor a nested `ContentArea` builds.
 *
 * ContentArea owns its BlockNote editor and has no hook for a caller's
 * plugins, so the plugin is attached from outside: tiptap marks the editor's
 * DOM node with the editor that owns it, and `registerEditorPlugin` adds the
 * plugin without breaking collaborative undo. ContentArea can rebuild its
 * editor (a note that binds to its Y.Doc after first paint), so a mutation
 * observer re-attaches to whichever editor is current.
 *
 * Until a plugin is on, the caller keeps the editor out of sight: an editor
 * with no window would show the whole source note.
 *
 * @module note/content-area/portal/use-portal-window-plugin
 */

import { useEffect, useRef, type RefObject } from 'react'
import type { Plugin } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { createLogger } from '@/lib/logger'
import { registerEditorPlugin } from '../register-editor-plugin'
import {
  createPortalWindowPlugin,
  setPortalWindowSpec,
  type PortalWindowSpec
} from './portal-window-plugin'
import { registerPortalWindow } from './portal-window-registry'

const log = createLogger('PortalWindowPlugin')

interface TiptapLike {
  view: EditorView
  registerPlugin?: (plugin: Plugin) => void
  unregisterPlugin?: (key: unknown) => void
}

export interface PortalWindowResolution {
  rootFound: boolean | null
  rootText: string | null
}

export function usePortalWindowPlugin(options: {
  container: RefObject<HTMLElement | null>
  /** Attach only once the nested editor is mounted. */
  enabled: boolean
  portalBlockId: string
  sourceNoteId: string
  spec: PortalWindowSpec
  onResolve: (resolution: PortalWindowResolution) => void
  /** Called with whether a plugin is currently attached. */
  onAttached: (attached: boolean) => void
}): void {
  const { container, enabled, portalBlockId, sourceNoteId, spec, onResolve, onAttached } = options
  const specRef = useRef(spec)
  const onResolveRef = useRef(onResolve)
  const onAttachedRef = useRef(onAttached)
  const viewRef = useRef<EditorView | null>(null)

  useEffect(() => {
    specRef.current = spec
    onResolveRef.current = onResolve
    onAttachedRef.current = onAttached
  })

  useEffect(() => {
    const host = container.current
    if (!enabled || !host) return

    let attached: { tiptap: TiptapLike; detach: () => void } | null = null

    const detach = (): void => {
      attached?.detach()
      attached = null
      viewRef.current = null
      onAttachedRef.current(false)
    }

    const attach = (): void => {
      const dom = host.querySelector<HTMLElement & { editor?: TiptapLike }>('.ProseMirror')
      const tiptap = dom?.editor
      if (attached?.tiptap === tiptap) return
      if (attached) detach()
      if (!tiptap) return

      const plugin = createPortalWindowPlugin(specRef.current, (resolution) =>
        onResolveRef.current(resolution)
      )
      const unregisterPlugin = registerEditorPlugin({ _tiptapEditor: tiptap }, plugin)
      if (!unregisterPlugin) {
        log.error('Could not attach the portal window to the nested editor', { portalBlockId })
        return
      }
      const unregisterWindow = registerPortalWindow(portalBlockId, {
        view: tiptap.view,
        sourceNoteId
      })
      attached = {
        tiptap,
        detach: () => {
          unregisterWindow()
          unregisterPlugin()
        }
      }
      viewRef.current = tiptap.view
      onAttachedRef.current(true)
    }

    attach()
    const observer = new MutationObserver(attach)
    observer.observe(host, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      detach()
    }
  }, [container, enabled, portalBlockId, sourceNoteId])

  // A new spec is a new object every render; its two fields are its identity.
  const specKey = `${spec.anchor ?? ''}\n${spec.hidden.join('\n')}`
  useEffect(() => {
    const view = viewRef.current
    if (view && !view.isDestroyed) setPortalWindowSpec(view, specRef.current)
  }, [specKey])
}
