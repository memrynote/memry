# Version History

Browse prior versions of a note and restore one if needed.

<!-- screenshot: version history panel showing a timeline -->

## Opening History

From the note menu, choose **Version history**. A side panel opens with a timeline of versions.

## What's Captured

A version is a point-in-time snapshot of the note. memrynote creates a version:

- On significant pauses in editing (debounced)
- Before major automated actions (e.g. template apply)
- On a regular cadence during long writing sessions

Versions store the full note content; they aren't diffs.

## Browsing Versions

Each entry shows:

- A relative timestamp ("2 hours ago", "yesterday")
- An exact timestamp on hover
- A short preview (first 1–2 lines)

Selecting a version shows it in a **read-only** preview pane. The current note remains unchanged.

## Restoring

Click **Restore** on a selected version to replace the current note content with that version.

The previous state is **itself recorded as a new version** — restore is non-destructive.

## Diff View

Toggle a diff view to compare the selected version against the current. Adds, deletes, and modifications are color-coded.

## Retention

memrynote keeps a rolling history of recent saves locally. Older versions are pruned automatically to keep storage bounded. The retention window favors a dense recent history (last day) and thinning older points (last week, last month).

## Per-Device Retention

Version history is local to the device — versions don't currently sync. If you write on Device A and Device B doesn't have the same version timeline, that's expected.

## Privacy

Version content lives in the data DB and is encrypted at rest along with everything else.
