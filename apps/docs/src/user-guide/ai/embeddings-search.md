# Embeddings & Semantic Search

Run a local embedding model so search ranks by meaning, not just keywords.

<!-- screenshot: embeddings model status in settings with progress -->

## What This Powers

When embeddings are loaded, memrynote can rank notes by **semantic similarity** to your query — not just keyword overlap. This affects:

- The [search palette](/user-guide/search) (semantic boost on top of keyword match)
- "Related notes" suggestions in some surfaces
- **Similar notes** under a note, **suggested tags** on an untagged note, and **Suggest groups**
  on a canvas (see below)

A query like "setting up authentication" can surface a note titled "OAuth flow" even when the words don't overlap.

## Enabling

1. Open [Settings → AI](/user-guide/settings#ai)
2. Toggle **Enable**
3. Under Embedding Model, click **Download** to pull the model
4. Wait for the status to say **Loaded**
5. Click **Rebuild Index** to embed every existing note (one-time per model)

The first index build can take a few minutes for large vaults — progress is shown.

## The Model

memrynote uses Google's **EmbeddingGemma 2** (text only, 256 dimensions). It understands 100+
languages, so notes in Turkish, German, Japanese and others are matched by meaning, including across
languages: an English query can find a Turkish note on the same topic. Notes are embedded up to their
first ~4000 characters, title first.

When you update from a version that used the older English-only model, memrynote discards the old
vectors and re-embeds every note in the background once. Similar notes and suggestions fill back in as
that pass runs.

Intel Macs are not supported by the local model runtime; on those machines semantic features stay off
and search is keyword-only.

## Model Management

The status line shows:

- **Loaded** — ready
- **Loading** — initialization in progress
- **Not downloaded** — needs download
- **Error** — see logs; usually disk space, a hash mismatch, or a failed download

You can **Unload** the model from settings to free memory; reload as needed.

### When the Download Fails

The model is fetched once (~210MB). If that download fails — you are offline, behind a proxy, or the
CDN is blocked — memrynote does **not** hammer the network. It waits before trying again, backing off
each time (about one minute, then two, four, and eight), and after several consecutive failures it
stops retrying for the rest of the session. Semantic search falls back to keyword-only meanwhile;
nothing else is affected, and no notes are lost.

If the connection comes back on its own, a later retry picks it up and indexing resumes with no action
from you. To retry immediately instead of waiting out the backoff, do any of these — each one clears
the wait:

- Toggle **Enable** off and on in [Settings → AI](/user-guide/settings#ai)
- Click **Download** / **Load model**
- Click **Rebuild Index**

Restarting memrynote also clears it.

Opening a vault never blocks on embeddings. When a vault has notes that still need embedding — for
example the first open after importing a vault — memrynote embeds them in the **background** after the
vault is already open, so a large vault (or a slow or failed model download) can never hold up opening.

Closing a vault, switching vaults, and quitting never block on embeddings either: a background
embedding pass stops at the next note rather than finishing its whole queue. Notes it did not reach
keep their place in line and are embedded by the next background pass.

Beyond that, the model is loaded lazily: semantic surfaces such as search, inbox linked-note
suggestions, related notes, and reindexing start the local model on first use. The model runs in a
separate utility process and shuts down after an idle period, so regular note reading does not keep the
embedding runtime resident forever.

## Similar Notes, Suggested Tags, and Canvas Groups

These three features answer "which of my notes belong together?" from the vectors already stored on
this device. None of them reads note text or runs the model when you open a note: they compare stored
vectors only. They are hidden while embeddings are turned off, and they never change anything until you
act on them.

### Similar notes

Below a note's backlinks and outgoing links, **Similar notes** lists up to five notes that read like it.
Notes this one already links to, and notes that link to it, are left out, since you have already made
that connection. A note too short to embed, or one that has not been embedded yet, shows no list.

Hover a row for two actions:

- **Link from this note** adds a `[[Title]]` link on a new line at the end of the note. It is an ordinary
  edit, so undo removes it, and the note drops off the list once the link is saved.
- **Add to canvas** puts a card for the similar note on a canvas you pick. A note already on that canvas
  is not added twice. This action appears only when canvases are turned on.

### Suggested tags

A note with no tags shows **Suggested tags** under its title: tags that at least two of its most similar
notes carry, strongest first. Click one to add it. It goes through the normal tag path, the same as
adding it by hand. Click the **x** to hide the suggestions for that note.

### Suggest groups on a canvas

**Suggest groups** (top right of a canvas) groups the note cards on the board by similarity. With two or
more note cards selected, only the selection is grouped. It groups up to 300 notes at a time; on a bigger board,
select some cards first. Each proposed group gets a name from a tag or
folder most of its notes share, or a plain "Group 1" when they share none.

Review the groups before anything happens: untick a group to discard it, or rename it. **Create frames**
then puts each accepted group's cards into a named frame, laid out as a grid. If other drawings are on
the board, the frames go to their right so nothing is covered. One undo takes the whole change back.
Task, event, file, and project cards are not grouped.

## Model Size

Models trade off accuracy vs disk and memory. The default is tuned for desktop hardware. The settings page shows dimensions and the current count of embedded notes.

## Reindexing

Rebuild the index after:

- Switching models
- Restoring a vault from backup
- A migration that touched note storage

Reindexing is incremental — memrynote skips notes whose content hash hasn't changed.

A reindex — and a settings change that reclassifies notes, such as moving the journal or default note
folder — embeds the notes it touched in the background as soon as the pass finishes. You do not need
to reopen the vault for semantic search to see them.

## Privacy

Embeddings are computed **on-device**. The vectors are stored in the local index database (`<vault>/index.db`). They are **never sent** to a server.

Even if you sync across devices, embeddings are recomputed locally — the embedding payload itself is not part of the sync stream.

Similar notes, suggested tags, and canvas group suggestions are computed from those local vectors. No
note text, title, or vector leaves the device for any of them. What you accept (a link, a tag, a card, a
frame) is an ordinary edit and syncs like any other.

## Performance

Once the index is built, semantic search adds <50ms to a typical query. Embedding is the expensive step (one-time per note); ranking is cheap.

If you have an enormous vault and notice slowdowns, the index can be rebuilt fresh in settings.

## Disabling Embeddings

Toggle **Enable** off. The model unloads. The vector index stays on disk (you can delete the file manually if you want it gone).

Search falls back to keyword-only — fast, but less forgiving of varied phrasing.

## See Also

- [Search & Command Palette](/user-guide/search)
- [Provider Setup](/user-guide/ai/provider-setup) — provider config for the inline AI menu (separate from embeddings)
