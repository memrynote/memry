# Cover Image

A note can carry a cover image: a single picture across the top of the page, above the title.

## Adding a Cover

Hover the area above a note's title. Alongside **Add property** and **Add tag**, a third ghost
button appears: **Add cover**.

Clicking it opens the same attachment picker `/image` uses in the editor, so there are two routes
in one list — upload a new image from your computer, or pick one the vault already has. See
[Attachments](/user-guide/notes/attachments#the-attachment-picker) for how that picker works.

The cover renders at the full width of the note content, at a fixed height, cropped to fill it.
There is no reposition handle: the image is centred on itself and that is the whole of it.

## Changing or Removing a Cover

Hover the cover itself and two buttons appear on it: **Change cover** and **Remove cover**.

**Change cover** reopens the picker. **Remove cover** takes the image off the note and deletes the
`cover` key from its frontmatter — the note goes back to having no cover at all, and nothing else
about it changes.

## How It Is Stored

The cover lives in the note's YAML frontmatter, under a root `cover` key:

```yaml
---
cover: ../attachments/a1b2c3d4/e5f6g7-harbour.jpg
---
```

The value is either a path relative to the note, or a URL that already carries an `http://` or
`https://` scheme. It is never an absolute path like `/Users/you/vault/attachments/...`, and that
is deliberate. An absolute path describes one machine's filesystem. The moment the note reaches a
second device through sync, that path points at nothing — a different home directory, a different
vault location, sometimes a different operating system. A note-relative path is the only shape that
still means the same image on both ends.

The file itself stays a plain markdown file with a plain frontmatter block, so another editor
reading the same vault sees a readable `cover:` line rather than anything memrynote-specific.

## When `cover` Is Just a Property

`cover` is an ordinary word, and it was a usable property name long before it meant a picture. A
book note with `cover: Hardback` in its frontmatter is saying something about the binding.

So the key alone does not make a cover — the value does. memrynote treats `cover` as a cover image
only when the value looks like one: an image path, or an `http`/`https` URL. Anything else stays a
plain text property and shows in the properties list exactly as it did before, untouched.

## Where Covers Appear

Covers are a note-page feature. Journal entries and the template editor do not show one.

A `cover` key in a journal file or a template is left alone — it is read and written back as it was
found, so nothing is lost if the file came from somewhere else or you added the key by hand.
