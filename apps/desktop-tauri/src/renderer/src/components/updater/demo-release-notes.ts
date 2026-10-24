/**
 * Dummy release-notes body shaped like the real GitHub update feed: curated emoji
 * bullets under section headings + a Changelog section whose `#NNN` references and
 * "Full Changelog" URL are clickable <a> links (this is exactly what the tab keeps
 * that the popover's three-bullet summary strips).
 *
 * Lives in its own module so the dev-only updater helper in `use-app-updater` can
 * reuse it without pulling a React component and the tabs context into its graph.
 */
export const DEMO_RELEASE_NOTES_HTML = `
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

/** Plain-text notes matching `DEMO_RELEASE_NOTES_HTML`, as the update feed's stripped body. */
export const DEMO_RELEASE_NOTES = [
  'Daily inbox review reminder — a gentle nudge each day to clear your inbox.',
  'Inline PDF embeds — drop PDFs into a note and resize, align, or drag them in.',
  'Drag tasks onto the calendar — schedule a task by dragging it onto a day.',
  'Darker dark theme — deeper backgrounds and clearer surfaces.',
  'Smarter sync negotiation — clients agree on sync types per connection.'
].join('\n')
