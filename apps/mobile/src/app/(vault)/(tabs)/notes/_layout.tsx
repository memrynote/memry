import { useCallback, useEffect, useState } from 'react'
import { router, Stack } from 'expo-router'
import { EditorHost } from '@/editor/editor-host'
import { getEditorSession } from '@/editor/session'
import type { VaultDb } from '@/db/index'
import { WorkspaceTabsProvider } from '@/features/workspace-tabs/provider'
import { createLogger } from '@/lib/logger'
import { loadCurrentVaultId } from '@/sync/auth-client'

const log = createLogger('NotesLayout')

export default function NotesLayout() {
  const [db, setDb] = useState<VaultDb | null>(null)

  useEffect(() => {
    let cancelled = false
    void loadCurrentVaultId()
      .then(async (vaultId) => {
        if (!vaultId) return
        const session = await getEditorSession(vaultId)
        if (!cancelled) setDb(session.db)
      })
      .catch((error: unknown) => {
        log.warn('Workspace tabs could not open their local store', { error: String(error) })
      })
    return () => {
      cancelled = true
    }
  }, [])

  const navigate = useCallback((noteId: string | null) => {
    if (noteId) router.replace(`/notes/${noteId}`)
    else router.replace('/notes')
  }, [])

  // `EditorHost` renders ONE editor WebView as a sibling of the stack (#2030).
  // This layout is mounted while the notes list is on screen and stays mounted
  // across every `router.push('/notes/<id>')`, so the guest is warm before the
  // first tap and every note after it switches with a `doc-load` instead of a
  // fresh WKWebView — which was 489 ms of a 567 ms open.
  //
  // Every screen in this stack draws its own nav bar (boards 26, 27, 28/29).
  // Left `true`, the native header renders for the whole push animation and is
  // only torn down once a per-screen `Stack.Screen` override lands a frame
  // later — a second bar visibly stacked over the real one on every open.
  return (
    <WorkspaceTabsProvider db={db} navigate={navigate}>
      <EditorHost>
        <Stack screenOptions={{ headerShown: false }} />
      </EditorHost>
    </WorkspaceTabsProvider>
  )
}
