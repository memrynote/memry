# Custom Icons

Folders, notes, tags, projects and canvases all take an icon from the same picker. Alongside the
**Emoji** and **Icons** tabs there is a **Custom** tab: your own images, added once and reusable
everywhere.

## Adding an Icon

Open any icon picker — click a folder's icon in the sidebar, or a note's icon next to its title —
and switch to **Custom**.

Inside a note, the icon sits to the left of the title. Click it to change it, or to remove it from
the same picker. A note with no icon shows no placeholder there — set its first icon from the
sidebar or from a folder row, and it then appears in the note itself.

When a folder is open as a tab, you can also right-click any note there and choose **Set Icon**
(or **Remove Icon**, when the note already has one). This works in the Table, List, and Gallery
layouts. That opens the same picker in a centred dialog, which is handy when the note's own icon is
not on screen.

To give many notes the same icon, for example to mark every meeting note, select them in the Table
layout and choose **Set icon** in the bar at the bottom. The icon goes on every selected note. Tasks,
inbox items, and files such as PDFs are skipped. When a selected note already has an icon, the picker
also offers **Remove**. The confirmation has an **Undo** button that gives each note its previous
icon back.

- **Drop an image** anywhere on the panel,
- **Click the upload area** and pick one or more files, or
- **Paste a link** into the link field and press Enter.

Dragging an image straight out of a browser window works too — it arrives as a link, and is
handled the same way.

The panel opens beside the icon you clicked, and never off the edge of the window: in a window too
short to hold it, the tabs and the **Remove** row stay put and the grid below them scrolls. It also
stays open if the sidebar scrolls underneath it — it follows the row it belongs to.

Each new icon is named after its file, minus the extension; a linked icon is named after the file
name in the link, or the site it came from. Hover a row and click the pencil to rename it; the name
is what the search box matches, so name them the way you would look for them later. The trash icon
removes an icon from the library.

Every icon you add stays listed until you delete it. Uploading is not a one-shot action — the
library is the point.

## Adding by Link

A link is downloaded once, when you add it, and then it is over. What lands in your library is the
image itself, stored exactly like an uploaded one — never a reference to somebody else's server.

That is deliberate. An icon that pointed at a URL would mean every folder in your sidebar making a
request to render, telling that server when you look at what; it would break the moment the link
went dead; and whoever owns the address could swap the picture underneath you afterwards. None of
that can happen to a downloaded icon.

The download itself treats the remote side as untrusted: only `http` and `https` links are fetched,
the response is capped at 2 MB no matter what size it claims, and the bytes have to actually be an
image before anything is stored. If a link fails, the field keeps what you typed so you can fix it.

## Supported Files

PNG, JPG, GIF, WEBP and SVG, up to 2 MB each — uploaded or linked.

Raster images are re-encoded to PNG at a longest edge of 128 pixels. That is deliberate: it keeps
each icon a few kilobytes, and it drops whatever metadata (camera model, GPS, editing history) the
original file carried. Animated GIFs keep their first frame only.

SVG files keep their vector shape instead of being re-encoded, so they stay sharp at any size. They
are cleaned up on the way in: script, event handlers, embedded markup and anything that would reach
out to another server are stripped, and the icon is rendered as an image only. Titles, gradients,
masks and clipping paths survive untouched, so an ordinary icon looks exactly as its author drew it.
An SVG that has nothing left to draw after cleaning is rejected as unreadable.

Removing the background from an image is not supported — an icon is stored the way you gave it,
minus the cleanup above.

## Where the Files Live

Icons are stored inside your vault at:

```
<vault>/.memry/icons/<id>.<ext>
```

They are local files, not links to the web. Rendering an icon never touches the network — the one
request memrynote makes is the single download when you add an icon by link — so a sidebar full of
custom icons costs no requests and leaks nothing about which folder you are looking at.

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
