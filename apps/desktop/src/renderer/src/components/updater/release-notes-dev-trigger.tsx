import { useEffect } from 'react'
import { useTabs } from '@/contexts/tabs'
import { createLogger } from '@/lib/logger'

const log = createLogger('Dev:ReleaseNotesTrigger')

/**
 * Dummy release-notes body shaped like the real GitHub update feed: curated emoji
 * bullets under section headings + a Changelog section whose `#NNN` references and
 * "Full Changelog" URL are clickable <a> links (this is exactly what the tab keeps
 * that the modal strips).
 */
const DEMO_RELEASE_NOTES_HTML = `
<h2>New Features</h2>
<ul>
  <li>📥 Daily inbox review reminder — a gentle nudge each day to clear your inbox.</li>
  <li>📄 Inline PDF embeds — drop PDFs into a note and resize, align, or drag them in.</li>
  <li>📅 Drag tasks onto the calendar — schedule a task by dragging it onto a day.</li>
</ul>
<h2>Improvements</h2>
<ul>
  <li>🌑 Darker dark theme — deeper backgrounds and clearer surfaces.</li>
  <li>🔄 Smarter sync negotiation — clients agree on sync types per connection.</li>
</ul>
<h2>Fixes</h2>
<ul>
  <li>⌨️ Delete-key crash — fixed forward-delete at the end of a document.</li>
  <li>〽️ Underline persistence — underlined text now survives save + reload.</li>
</ul>
<h2>Changelog</h2>
<p>Full Changelog: <a href="https://github.com/memrynote/memry/compare/2026.719.2...2026.999.9">2026.719.2...2026.999.9</a></p>
<p><a href="https://github.com/memrynote/memry/pull/818">#818</a> feat(updater): short-interval polling, silent opt-in download, read-only release-notes tab @kaan</p>
<p><a href="https://github.com/memrynote/memry/pull/811">#811</a> feat(canvas): M4 — E2E-encrypted cross-device sync @kaan</p>
<p><a href="https://github.com/memrynote/memry/pull/785">#785</a> feat(canvas): spatial canvas (Excalidraw) M0–M3 @kaan</p>
`.trim()

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
