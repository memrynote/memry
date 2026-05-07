# Capturing to Inbox

The inbox is a capture surface for things you want to process later: links, files, voice memos, video, PDFs, web clips, and social posts. Get them in fast; triage them later.

<!-- screenshot: inbox view with mixed item types -->

## Capture Input

A capture input at the top of the inbox view accepts:

- Free-text notes
- Pasted URLs (Memry fetches the title and a snippet)
- Pasted file paths

Press <kbd>Enter</kbd> to add. The new item lands at the top of the list as **pending**.

## Drag and Drop

Drop files from your OS file manager onto the inbox window. Memry:

- Copies the file into the vault
- Detects type (image, PDF, video, etc.)
- Creates an inbox item with the file as content

Multiple files dropped at once create one inbox item per file.

## Voice Capture

The inbox header has a voice button. Click to start recording, click again to stop. The recording becomes an inbox item under the **voice** content type.

If voice transcription is enabled, Memry transcribes the audio in the background — see [Voice Transcription](/user-guide/ai/voice-transcription).

## Web Clips and Browser Extension

When the browser extension (or quick-share integrations) are available, sharing a page from your browser creates an inbox item with:

- The page title
- The source URL
- A snippet or selected text
- Sometimes a screenshot

Web clips appear under the **clips** content type filter.

## Social Posts

If you've connected social capture (e.g. saving tweets), those land in inbox under the **social** content type. The original URL is preserved so you can revisit the source.

## Pending vs Triaged

Captured items default to **pending**. They stay in the active inbox list until you triage them — see [Triage Mode](/user-guide/inbox/triage).

## Capture from Inside Memry

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
