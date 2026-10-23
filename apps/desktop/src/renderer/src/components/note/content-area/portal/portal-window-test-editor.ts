/**
 * A real BlockNote editor with the portal window attached, for the window,
 * boundary and plan tests. Callers mock `react-pdf` and `@/lib/url-metadata`
 * first, as the other editor tests do.
 */

import type { PartialBlock } from '@blocknote/core'
import type { Plugin } from '@tiptap/pm/state'
import { registerEditorPlugin } from '../register-editor-plugin'
import { createAnchorVisibilityPlugin } from './anchor-visibility-plugin'
import { createPortalDropGuardPlugin } from './portal-drop-guard-plugin'
import { createPortalBoundaryPlugin } from './portal-boundary-plugin'
import type { PortalWindowCallbacks } from './portal-plans'
import { createPortalWindowPlugin, type PortalWindowSpec } from './portal-window-plugin'
import { mountTestEditor } from './portal-test-editor'

const prepend = (plugin: Plugin, plugins: Plugin[]): Plugin[] => [plugin, ...plugins]

export function mountPortalWindow(
  blocks: PartialBlock[],
  spec: PortalWindowSpec,
  callbacks: PortalWindowCallbacks = { onPlan: () => undefined }
) {
  const mounted = mountTestEditor(blocks)
  const resolved: Array<{ rootFound: boolean | null; rootText: string | null }> = []
  registerEditorPlugin(
    mounted.editor,
    createPortalWindowPlugin(spec, (r) => resolved.push(r))
  )
  registerEditorPlugin(mounted.editor, createAnchorVisibilityPlugin())
  registerEditorPlugin(mounted.editor, createPortalBoundaryPlugin(callbacks), prepend)
  registerEditorPlugin(mounted.editor, createPortalDropGuardPlugin())
  return { ...mounted, resolved }
}
