import App from './App'
import { CrdtPersistenceNotice } from './components/crdt-persistence-notice'
import { AuthProvider } from './contexts/auth-context'
import { SyncProvider } from './contexts/sync-context'
import { WritebackFailureNotice } from './components/writeback-failure-notice'

/**
 * The main window's tree below the providers every window shares (main.tsx).
 * Loaded by main.tsx only when the window is not quick capture, so the quick
 * capture window never evaluates App or the auth and sync providers.
 */
export function MainWindowRoot(): React.JSX.Element {
  return (
    <AuthProvider>
      <SyncProvider>
        <App />
        {/* After <App />, so the Toaster it renders is already mounted. */}
        <CrdtPersistenceNotice />
        <WritebackFailureNotice />
      </SyncProvider>
    </AuthProvider>
  )
}
