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

## Drag and Drop

Drop files from your OS file manager onto the inbox window. memrynote:

- Copies the file into the vault
- Detects type (image, PDF, video, etc.)
- Creates an inbox item with the file as content

Multiple files dropped at once create one inbox item per file.

## Voice Capture

The inbox header and inline capture input include a voice recorder. Click to start recording, click
again to stop. The recording becomes an inbox item under the **voice** content type.

If voice transcription is enabled, memrynote transcribes the audio in the background — see [Voice Transcription](/user-guide/ai/voice-transcription).

If voice transcription setup is incomplete, memrynote takes you to AI settings before recording.

## Web Clips and Browser Extension

The memrynote browser extension captures the page you're reading straight into your inbox. Web clips
appear under the **clips** content type filter.

### Pairing

The extension talks to the desktop app over a local loopback connection — nothing leaves your
machine. The first capture prompts memrynote to show an **Allow / Deny** pairing dialog; approving it
issues the extension a token. Until paired, the popup shows a needs-pairing state.

### Capture modes

The popup offers three ways to grab a page:

- **Article** — the readable main content, stripped of navigation and ads (the default).
- **Selection** — only the text you've highlighted on the page.
- **Screenshot** — a stitched full-page image, captured by scrolling the page.

Article and Selection land as text; Screenshot lands as an image attachment.

### Keyboard shortcut

Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> (<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> on
macOS) to capture the current page in Article mode without opening the popup. A brief ✓ badge
confirms the save. Rebind it at `chrome://extensions/shortcuts` if it collides with another
extension. (The shortcut is Article-only — Selection and Screenshot need the popup.)

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
