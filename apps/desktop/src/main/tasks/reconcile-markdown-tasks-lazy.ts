import { createLogger } from '../lib/logger'
import type { TaskCheckboxSource } from './reconcile-markdown-tasks'

const log = createLogger('ReconcileMarkdownTasks')

/**
 * Fire-and-forget `reconcileTaskCheckboxesFromMarkdown` for the vault read
 * paths. The reconciler is loaded on first use: the tasks domain reaches back
 * into note writes (header status sync), so a static import from the vault
 * modules is a cycle.
 */
export function reconcileTaskCheckboxesLazily(noteId: string, source: TaskCheckboxSource): void {
  if (!source.markdown.includes('{task:')) return
  void import('./reconcile-markdown-tasks')
    .then(({ reconcileTaskCheckboxesFromMarkdown }) => reconcileTaskCheckboxesFromMarkdown(source))
    .catch((err: unknown) => {
      log.warn('Failed to reconcile task checkboxes from a note read', { noteId, error: err })
    })
}
