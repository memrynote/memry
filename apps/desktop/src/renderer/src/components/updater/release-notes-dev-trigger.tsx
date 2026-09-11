import { useEffect } from 'react'
import { useTabs } from '@/contexts/tabs'
import { createLogger } from '@/lib/logger'
import { DEMO_RELEASE_NOTES_HTML } from './demo-release-notes'

const log = createLogger('Dev:ReleaseNotesTrigger')

export { DEMO_RELEASE_NOTES_HTML } from './demo-release-notes'

/**
 * Dev-only: exposes `window.openReleaseNotesDemo([version])` so the read-only
 * release-notes tab can be inspected with dummy data without a packaged updater run
 * (the updater is `app.isPackaged`-gated and never fires in dev). Mounted only under
 * `import.meta.env.DEV`, so it is stripped from production builds and never registers
 * the helper there.
 */
export function ReleaseNotesDevTrigger(): null {
  const { openTab } = useTabs()

  useEffect(() => {
    if (!import.meta.env.DEV) return

    const open = (version = '2026.999.9'): void => {
      openTab({
        type: 'virtual-note',
        title: `MemryNote ${version}`,
        icon: 'file-text',
        path: `/virtual/release-notes/${version}`,
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false,
        viewState: { content: DEMO_RELEASE_NOTES_HTML, contentType: 'html' }
      })
    }

    const win = window as unknown as { openReleaseNotesDemo?: (version?: string) => void }
    win.openReleaseNotesDemo = open
    log.info('dev helper ready — run openReleaseNotesDemo() in the console to open the tab')

    return () => {
      delete win.openReleaseNotesDemo
    }
  }, [openTab])

  return null
}
