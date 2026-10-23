# Readwise vault formats

The Readwise sync writes three things into a vault that other builds read back: the book section markers, the journal day markers, and the image attachment names. Devices on different app versions share one vault, so these are formats you can add to but not change. The code is in `apps/desktop/src/main/readwise/` and `packages/importers/src/readwise/`. The user guide is [Readwise](../user-guide/readwise.md).

## Why markers

A note holds text the sync writes and text the user writes. The sync must update its own text, and must never overwrite the user's. So it fences its text between two HTML comments, and stores a fingerprint of what it wrote in the closing comment. A later run reads the section, hashes the body, and compares. A match means the user has not touched the section, so the run re-renders it. A mismatch means the user edited it, so the run only appends.

## Book section, `readwise` v1

```markdown
<!-- readwise:start -->

## Highlights

- ...

<!-- readwise:end v1 last=2026-10-23T00:15:50.792Z hash=25e1e07d -->
```

- `readwise:start` opens the section. It carries no attributes.
- `readwise:end` closes it and carries `v1`, `last` and `hash`.
- `v1` is the format version. A reader that finds another version writes nothing to the note.
- `last` is the creation time of the newest highlight the section holds, as an ISO instant with milliseconds. It is the cursor for appends: a later run appends highlights created at or after it that the note does not link yet. A highlight whose image failed to download is held back, and `last` stays before it. A note with no highlights uses `1970-01-01T00:00:00.000Z`.
- `hash` is a 32-bit FNV-1a of the section body, as 8 hex digits. It ignores line endings and trailing whitespace, so CRLF on Windows does not read as an edit. An append to an edited section moves `last` and keeps the old hash, so the section stays edited.
- A missing end marker is added. Two start or end markers, or a marker inside a line of text, count as an edit.
- The editor draws both comments as labeled dividers (**Readwise · syncs automatically**). The file keeps the comments as written. iOS draws them as a thin labeled line.

## Journal day section, `readwise-day` v1

```markdown
<!-- readwise-day:start -->

### Readwise

- [[Deep Work]]: 3 highlights

<!-- readwise-day:end v1 hash=4b1e09aa -->
```

- It lives in the journal entry of the day the highlights were made, in the device's time zone.
- It has no `last`. Each run rebuilds the whole day from the device-local highlight index, so an untouched section is a pure function of that day's highlights.
- `hash` is the same FNV-1a over the body. If it no longer matches, the section is edited. The sync then adds one line per book that got new highlights, before the end marker, and never rewrites the section.
- Book titles in links are sanitized: `[`, `]` and `|` become spaces, and `<!--` is removed. Books are ordered by their first highlight of that day, then by title.
- Its start and end markers are different strings from the book section's, so one reader serves both without confusion.

## Frontmatter written at creation

A note gets its properties once, when it is created. `readwise_url` is the identity: it ties a note to its Readwise book, and a device that takes over adopts existing notes by it. Other properties are `author`, `category` (lower case), `source`, `source_url`, `tags` (book tags) and, for articles, `cover`. A Reader document also gets `site_name`, `published_date` (`YYYY-MM-DD`) and `word_count`. A property Readwise has no value for is left out.

## Image attachments

Remote images are downloaded so a note works offline.

```
attachments/<note id>/rw-<16 hex>.<ext>
```

- The 16 hex digits are the first 16 of the SHA-256 of the image URL, so the same image gets the same name on every device and a re-run reuses the file.
- `<ext>` is `jpg`, `png`, `webp`, `gif` or `avif`, taken from the response content type.
- Each image is capped at 25 MB. A failed download leaves the image out of the note and the next run tries again.

## Compatibility

Add attributes after `v1` only in a way an older reader ignores. A reader that does not know a marker version must write nothing to the note, which keeps a newer build's section intact. A change that older builds cannot read needs a new version number, never a new meaning for `v1`.
