# Capturing to Inbox

The inbox is a capture surface for things you want to process later: links, files, voice memos, video, PDFs, web clips, and social posts. Get them in fast; triage them later.

<!-- screenshot: inbox view with mixed item types -->

## Capture Input

A capture input at the top of the inbox view accepts:

- Free-text notes
- Pasted URLs (memrynote fetches the title, a snippet, and the full readable article)
- Pasted file paths

Press <kbd>Enter</kbd> to add. The new item lands at the top of the list as **pending**.

## Readable Article Capture

When you paste a link, the card appears immediately with its title and snippet. A moment later
memrynote fetches the page and extracts the **full readable article** — the main content, stripped of
navigation, ads, and boilerplate — into the item body as Markdown.

Alongside the article it captures a property set:

- `title` — the article headline
- `source` — the original URL
- `author`, `published`, `description` — when the page provides them
- `created` — when you captured it
- `tags` — defaults to `clippings`

When you [file the item to a note](/user-guide/inbox/triage), the readable article becomes the note
body and these properties become the note's frontmatter, so a clipped article opens as a clean,
attributed note.

Extraction runs in the background after metadata, so the body fills in within a few seconds. If a
page can't be read cleanly (e.g. a login wall), the card keeps its title and snippet and the article
body is skipped.

In the inbox detail view the captured article renders as formatted rich text — headings, bold, links,
and lists — exactly as it appears in the note editor, rather than as raw Markdown. You can edit it
inline before filing.

## Drag and Drop

Drop files from your OS file manager onto the inbox window. memrynote:

- Copies the file into the vault
- Detects type (image, PDF, video, etc.)
- Creates an inbox item with the file as content

Multiple files dropped at once create one inbox item per file.

## Voice Capture

The inbox header and inline capture input include a voice recorder. Click to start recording, click
again to stop. The recording becomes an inbox item under the **voice** content type.

While recording, a red dot marks the live microphone and the timer turns amber during the last 30
seconds before the 5-minute limit. Keyboard shortcuts work too: **Esc** cancels the recording,
**Enter** or **Space** stops and saves it.

The bars next to the timer are a live level meter that scrolls 20 times a second, so you can see
the microphone is picking you up. It measures loudness only — memrynote does no more audio analysis
per second than those 20 updates need, keeping a long recording cheap to leave running.

The recording's waveform is captured alongside the audio, so the detail panel shows the real
waveform instantly when you open a voice item. Older voice items recorded before waveforms were
stored are decoded on demand instead; if that file is missing or unreadable the panel keeps the flat
placeholder bars, and playback of other voice items stays unaffected no matter how many you open.

If voice transcription is enabled, memrynote transcribes the audio in the background — see [Voice Transcription](/user-guide/ai/voice-transcription).

If voice transcription setup is incomplete, memrynote takes you to AI settings before recording. If
the operating system has denied microphone access, the recorder's **Settings** button opens the OS
microphone privacy pane directly (macOS and Windows).

## Web Clips and Browser Extension

The memrynote browser extension captures the page you're reading straight into your inbox. Web clips
appear under the **clips** content type filter.

### Supported browsers

The extension is a single cross-browser build that runs on Chrome, Edge, and Firefox (version 140 or
newer). Pairing and all capture modes work the same on each.

### Pairing

The extension talks to the desktop app over a local loopback connection — nothing leaves your
machine. The first capture prompts memrynote to show an **Allow / Deny** pairing dialog; approving it
issues the extension a token. Until paired, the popup shows a needs-pairing state.

### Capture modes

The popup offers four ways to grab a page:

- **Article** — the readable main content, stripped of navigation and ads (the default).
- **Selection** — only the text you've highlighted on the page.
- **Screenshot** — a stitched full-page image, captured by scrolling the page.
- **PDF** — when the tab is a PDF, the actual file. The popup shows a PDF badge instead of a content
  preview; you can still edit the title and tags before saving.

Article and Selection land as text; Screenshot lands as an image attachment; PDF lands as a PDF file
you can open in memrynote's built-in viewer and file into a folder like any other attachment.

### Clipping PDFs

When you open a PDF, the browser renders it with its own viewer, which extensions cannot read text
from. So the clipper saves the file itself instead.

The first time you clip a PDF from a given site, your browser asks whether to give memrynote access
to that site. This is needed to download the file with your session, so PDFs behind a login work.
The prompt appears once per site, not once per PDF.

Limits worth knowing:

- The tab's address has to end in `.pdf`, ignoring anything after a `?` or `#`. A PDF served from an
  address without that ending isn't recognised as one — the popup shows "Couldn't read this page"
  instead.
- PDFs up to **16 MB** can be clipped. Larger ones are better saved to disk and dragged into the
  inbox, which allows up to 50 MB.
- PDFs that can't be downloaded a second time — one-time links, or a file opened by submitting a form
  — can't be clipped. You'll see a message rather than a broken item.
- If you're signed out, the site may return its login page instead of the file. The clipper detects
  this and tells you rather than saving something unreadable.
- PDF clips are **not** queued when memrynote is closed. The popup opens the app and sends; if that
  fails, click again with the tab still open.

### Keyboard shortcut

Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> (<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> on
macOS) to capture the current page in Article mode without opening the popup. A brief ✓ badge
confirms the save. Rebind it at `chrome://extensions/shortcuts` if it collides with another
extension. (The shortcut handles Article and PDF — Selection and Screenshot need the popup. For a
PDF it only works on a site you've already granted access to through the popup, since a keyboard
shortcut can't show a permission prompt.)

### Offline queue

If memrynote is closed when you capture, the clip is saved to a local queue instead of being lost.
The toolbar badge shows the pending count. The extension retries about once a minute and, the moment
memrynote is open again, the queued clips sync into your inbox and the badge clears. The popup shows
"Saved offline" so you know it's queued, not dropped.

### Add & open

The popup's **Add & open in Memry** button captures the page and then jumps straight to the new item
in memrynote's inbox. (When memrynote is closed the capture queues instead, and the open is skipped —
there's nothing to open yet.)

### Settings

Open the extension's options page (right-click the toolbar icon → **Options**) to:

- **Re-pair** or **Unpair** the extension (unpair clears the local token even if memrynote is closed).
- **Rotate token** — revoke and immediately re-pair to mint a fresh token.
- **Port override** — leave blank to auto-detect (ports 7849–7856), or pin a specific port.

Link metadata scraping runs when a capture or preview needs it. The desktop app keeps the heavier
metadata scraper out of the cold inbox startup path so opening a vault does not load web-preview
dependencies before they are used.

## Social Posts

If you've connected social capture (e.g. saving tweets), those land in inbox under the **social** content type. The original URL is preserved so you can revisit the source.

## Pending vs Triaged

Captured items default to **pending**. They stay in the active inbox list until you triage them — see [Triage Mode](/user-guide/inbox/triage).

## Capture from Inside memrynote

You can also create inbox items from elsewhere in the app:

- Right-click a wiki link → "Add to inbox" (defers reading)
- Right-click a calendar event → "Add to inbox" (defers follow-up)

These are convenience actions for when you want to defer something without leaving the current context.

## What Capture Doesn't Do

Capture is fast on purpose. It does not:

- Auto-tag items
- Auto-file into projects (use [Triage](/user-guide/inbox/triage) for that)
- Send anything to the network (until sync runs and uploads encrypted state)

## See Also

- [Triage Mode](/user-guide/inbox/triage)
- [Filters & Views](/user-guide/inbox/filters)
- [Snooze & Archive](/user-guide/inbox/snooze-archive)
