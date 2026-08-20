# Custom Icons

Folders, notes, tags, projects and canvases all take an icon from the same picker. Alongside the
**Emoji** and **Icons** tabs there is a **Custom** tab: your own images, uploaded once and reusable
everywhere.

## Adding an Icon

Open any icon picker — click a folder's icon in the sidebar, or a note's icon next to its title —
and switch to **Custom**.

- **Drop an image** anywhere on the panel, or
- **Click the upload area** and pick one or more files.

Each new icon is named after its file, minus the extension. Hover a row and click the pencil to
rename it; the name is what the search box matches, so name them the way you would look for them
later. The trash icon removes an icon from the library.

Every icon you add stays listed until you delete it. Uploading is not a one-shot action — the
library is the point.

## Supported Files

PNG, JPG, GIF, WEBP and SVG, up to 2 MB each.

Raster images are re-encoded to PNG at a longest edge of 128 pixels. That is deliberate: it keeps
each icon a few kilobytes, and it drops whatever metadata (camera model, GPS, editing history) the
original file carried. Animated GIFs keep their first frame only.

SVG files are stored exactly as given. They render inside an image element, which never executes
script, so an SVG icon cannot run anything.

## Where the Files Live

Icons are stored inside your vault at:

```
<vault>/.memry/icons/<id>.<ext>
```

They are local files, not links to the web. memrynote never fetches an icon over the network, so
adding one costs no request and leaks nothing about which folder you are looking at.

Because they live under `.memry`, they are excluded from the note tree and from search — they will
not show up as stray attachments.

## Syncing

Custom icons sync with everything else on a paid plan. The image itself travels inside the
end-to-end encrypted record, so a second device rebuilds `.memry/icons` on its own — there is
nothing to copy by hand.

If a device ever ends up with a library entry whose file is missing (it pulled the icon while the
vault was closed, or the file was deleted outside the app), opening any icon picker rewrites it from
the synced copy.

## Deleting an Icon

Deleting an icon from the library removes it everywhere, on every device. Folders and notes that
were using it fall back to their default icon — nothing else about them changes, and you can pick a
new icon at any time.
