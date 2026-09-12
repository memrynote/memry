# Cover Image

A note can carry a cover: a band across the top of the page, above the title, spanning the full
width of the window. A cover is either a picture or a wash — one of twelve flat gradients that ship
with the app.

## Adding a Cover

Hover the area above a note's title. Three buttons fade in: **Add cover**, **Add tag** and
**Add property**.

**Add cover** opens the cover picker. It is a command palette, not a gallery: one search field, a
row of tabs, and a grid you can walk with the arrow keys. `↵` applies the highlighted cover. `⌘↵`
applies it and drops straight into repositioning. `esc` closes without changing anything.

### Washes

The first tab. Twelve gradients, no file and no download, applied the instant you press `↵`. A wash
costs nothing to sync and looks identical on every device, which makes it the fastest way to give a
note a face. Typing in the search field filters the washes by name and never leaves your device.

### Photos

Search Unsplash and use a photo as the cover. This tab only appears in builds configured with an
Unsplash access key.

Typing searches Unsplash while this tab is selected, and only while it is selected. On every other
tab the search field is a local filter, so the words you type stay on your machine.

Pressing `↵` downloads the chosen photo into the note's own attachments folder before it becomes the
cover. The cover is a file in your vault like any other, so it keeps working offline and the app
never reaches out to Unsplash to paint a page. The photographer's name and a link back to the photo
are stored with it and shown on the cover when you hover it.

The remaining hourly request allowance sits at the end of the tab row. Searches are debounced and
cached for as long as the picker is open, so browsing a term costs a single request.

### From note

Images the vault already holds. Picking one references the existing file rather than copying it, so
the same picture can head two notes without a second copy. See
[Attachments](/user-guide/notes/attachments#the-attachment-picker) for how vault attachments work.

### Upload

A picture from your computer, stored in this note's attachments folder.

## Repositioning a Photo

A photo is cropped to the band, so a tall image has to lose something. Hover the cover and choose
**Reposition**, or use `⌘↵` when applying it, then drag up and down to choose which part of the
picture the band keeps. `↑` and `↓` nudge it two percent at a time. `↵` saves the framing, `esc`
leaves it as it was.

Washes have no reposition control. A gradient has nothing to reframe.

## Changing or Removing a Cover

Hover the cover. A small toolbar appears in its lower corner: **Change**, **Reposition**, and an
`✕` that removes the cover. **Change** reopens the picker. Removing takes the cover off the note and
clears its keys from the frontmatter; the picture stays in your vault, and nothing else about the
note changes.

## If the Picture Is Missing

A photo whose file has been moved, deleted, or has not finished syncing to this device paints a wash
instead, chosen from the note's own identity so it is the same wash every time you open it. You will
never see a broken-image icon in a note.

## How It Is Stored

The cover lives in the note's YAML frontmatter, on root keys:

```yaml
---
cover: ../attachments/a1b2c3d4/e5f6g7-harbour.jpg
coverFocus: 42
coverCredit: Ana Ferreira
coverCreditUrl: https://unsplash.com/photos/Qx7a2Kp9
---
```

`cover` is either a path relative to the note, an `http`/`https` URL, or `wash:` followed by a wash
name such as `wash:sage`. `coverFocus` is the vertical framing, from 0 for the top of the picture to
100 for the bottom. The two credit keys are written only for a photo that came from Unsplash. Every
key is optional and each one is written only when it has something to say.

A cover path is never absolute, like `/Users/you/vault/attachments/...`, and that is deliberate. An
absolute path describes one machine's filesystem. The moment the note reaches a second device through
sync, that path points at nothing: a different home directory, a different vault location, sometimes
a different operating system. A note-relative path is the only shape that still means the same image
on both ends.

The file stays a plain markdown file with a plain frontmatter block, so another editor reading the
same vault sees readable `cover:` lines rather than anything memrynote-specific.

## When `cover` Is Just a Property

`cover` is an ordinary word, and it was a usable property name long before it meant a picture. A book
note with `cover: Hardback` in its frontmatter is saying something about the binding.

So the key alone does not make a cover — the value does. memrynote treats these keys as cover data
only when the value looks the part: an image path, an `http`/`https` URL, or a wash name for `cover`;
a number between 0 and 100 for `coverFocus`; a link for `coverCreditUrl`. Anything else stays a plain
text property and shows in the properties list exactly as it did before, untouched.

## Where Covers Appear

Covers are a note-page feature. Journal entries and the template editor do not show one.

A `cover` key in a journal file or a template is left alone — it is read and written back as it was
found, so nothing is lost if the file came from somewhere else or you added the key by hand.
