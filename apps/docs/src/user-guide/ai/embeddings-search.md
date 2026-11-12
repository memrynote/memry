# Embeddings & Semantic Search

Run a local embedding model so search ranks by meaning, not just keywords.

<!-- screenshot: embeddings model status in settings with progress -->

## What This Powers

When embeddings are loaded, memrynote can rank notes by **semantic similarity** to your query — not just keyword overlap. This affects:

- The [search palette](/user-guide/search) (semantic boost on top of keyword match)
- "Related notes" suggestions in some surfaces
- **Similar notes** under a note, **suggested tags** in the add-tag picker, and **Suggest groups**
  on a canvas (see below)

A query like "setting up authentication" can surface a note titled "OAuth flow" even when the words don't overlap.

## Enabling

1. Open [Settings → AI](/user-guide/settings#ai)
2. Toggle **Enable**
3. Check the Embedding Model status and indexing progress

Enabling AI starts a background pass for notes that need embeddings. The model downloads on first
use if its files are not already on disk. You do not need **Rebuild Index** to catch up after AI was
off. Existing vectors stay available while missing or changed notes are indexed.

The first index build can take a few minutes for large vaults. Keyword search remains available.

Memry unloads the model from memory about 30 seconds after the last embedding. The files stay on disk, so the status then reads **Downloaded**, and **Load Model** reads them from disk without downloading anything again.

## The Model

memrynote uses Google's **EmbeddingGemma 2** (256 dimensions). Its text half embeds notes; its image half, used only for [image search](#image-search), is a separate download. It understands 100+
languages, so notes in Turkish, German, Japanese and others are matched by meaning, including across
languages: an English query can find a Turkish note on the same topic. A note is embedded in
windows of ~4000 characters, title first, up to 16 windows (~64,000 characters), so text late in a
long note is found too. Search shows each note once, matched by its closest window.

When you update from a version that stored vectors in an older format, memrynote re-embeds every
note once in the background. Nothing is deleted first: the old vectors keep answering search
meanwhile, and each note's vector is replaced as the pass reaches it (notes with no vector at all go
first). Each note keeps two kinds of vector: one tuned for search, and one tuned for comparing it with
other notes. Similar notes, suggested tags, canvas groups and inbox filing read the second kind, so
until the pass reaches a note it is left out of those lists. If you quit before it finishes, the next launch continues with the notes it
has not reached yet instead of starting over.

## How Search Uses It

Typing in the search box runs two searches and merges them. The keyword search is unchanged. In
parallel, your query is embedded on this device and compared with the stored note vectors; the
notes nearest in meaning are merged with the keyword results by rank (Reciprocal Rank Fusion). A
note found by both rises. A note found only by meaning is listed after the keyword matches in the same
group and has no highlighted snippet. Typing `cat` can surface a note about kittens, in Turkish or
English, with no shared word.

Only a note's vector needs to exist, so a note that is not embedded yet is found by keywords only.
Meaning-only matches need a similarity of about 0.65 or more, so unrelated notes are not listed. The
first search after launch starts the model and answers by keywords alone, because loading takes
seconds; later searches include meaning. Queries with `AND`, `OR`, `NOT` or quoted phrases, queries
under three characters, and searches with embeddings off are keyword-only.

Intel Macs are not supported by the local model runtime; on those machines semantic features stay off
and search is keyword-only.

## Image Search

A photo with no text in it has nothing for keyword search or OCR to read. Image search embeds the
picture itself, so `cat` or `kedi` finds a cat photo, filed in your vault or embedded in a note. The
same search box and the same ranking apply: the picture's vector sits in the same space as note
text vectors, and a match lists the image (or the note that embeds it) with the other results.

- **Which images.** PNG, JPEG, WebP and GIF files you filed as notes of their own, and the ones a note
  embeds. SVG files and files over 30 MB are skipped.
- **Text and picture both count.** An image that also has text keeps its text vector (made from the
  OCR text), so a search for words in a screenshot still works, and gets a second vector from the
  picture, so a search for what it shows works too. A match on either lists it. The picture's own
  vector is made from the picture and its text together, so layout, charts and handwriting count
  alongside the words.
- **PDF pages.** The first 8 pages of each PDF get a vector each, made from the rendered page and the
  text read from it. Later pages are found by their text only. A page costs about 4 to 5 seconds of
  background CPU. On a small test set (14 rendered paper pages, 28 queries) this put the right page
  first for 93% of queries, against 79% for text alone and 82% for the picture alone.
- **One-time download.** The first time an image needs embedding, memrynote downloads the image
  model (about 109 MB). Notes without images never trigger it, and a vault without images never
  downloads or loads it. The model unloads again after an idle period.
- **Turn it off.** [Settings → AI](/user-guide/settings#ai) has a **Search images by content**
  switch under **Enable AI Features**. Off means no download, no image embedding, and images are found
  by keywords and OCR text only. Turning it off keeps existing image vectors on disk and ignores them.
  Turning it back on takes effect at the next vault open, which also embeds images added meanwhile.
- **Existing vaults.** The first open after updating embeds your existing images and PDF pages in the background,
  one at a time, after the vault is open. A quit part-way continues where it stopped. Renaming or
  moving an image re-embeds it under its new identity, and deleting it, or removing it from a note,
  drops its vector.
- **Limits.** Matching a picture to a word is looser than matching text to text, so image hits need
  a higher similarity (about 0.68) and a related animal can match, such as `dog` finding a cat photo.
  An image that fails to embed is tried again the next time its note changes or the vault opens.

Vectors stay in the local index database and are rebuilt from your vault; none of it syncs.

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

Closing or switching a vault cancels its background embedding pass. A calculation already in
progress may finish before the pass stops. Unfinished notes remain queued for a later pass. A
note-text rebuild from a closed vault cannot write vectors into the next vault's index.

Beyond that, the model is loaded lazily: semantic surfaces such as search, inbox linked-note
suggestions, related notes, and reindexing start the local model on first use. The model runs in a
separate utility process and shuts down after an idle period, so regular note reading does not keep the
embedding runtime resident forever. That process runs at low OS priority and gives each model
session at most two inference threads. Large imports can take longer to index, but no longer assign
half the machine's cores to inference. Other app work can still use CPU.

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

The add-tag picker on a note lists **Suggested** tags above **Recent**: tags that at least two of the
note's most similar notes carry, strongest first. Tags the note already has are left out. Click one to add
it. It goes through the normal tag path, the same as adding it by hand.

### Suggest groups on a canvas

**Suggest groups** (top right of a canvas) groups the note cards on the board by similarity. With two or
more note cards selected, only the selection is grouped. It groups up to 300 notes at a time; on a bigger board,
select some cards first. Each proposed group gets a name from a tag or
folder most of its notes share, or a plain "Group 1" when they share none.

Review the groups before anything happens: untick a group to discard it, or rename it. **Create frames**
then puts each accepted group's cards into a named frame, laid out as a grid. If other drawings are on
the board, the frames go to their right so nothing is covered. One undo takes the whole change back.
Task, event, file, and project cards are not grouped.

## Voice Memo Search

Voice memos in the Inbox join the same search box. A memo is indexed one of two ways, and a match
shows up in the **Inbox** group with the other results:

- **It has a transcript.** The transcript (and the memo's title) is embedded with the text model, so
  `dentist` finds a memo where you said "book the tooth doctor". Nothing extra is downloaded.
- **It has no usable transcript.** Transcription failed or was never turned on, or the recording is
  music, silence or other sound. memrynote embeds the audio itself, so `applause` can find a clapping
  recording. Memos are read as 16 kHz mono WAV (what Memry records); a recording longer than five
  minutes is split into windows and the best window counts, up to one hour.

A memo whose transcript arrives later switches from its audio vector to its transcript vector on the
next vault open or when the transcription finishes.

- **One-time download.** The first memo that needs its audio embedded downloads the audio model
  (about 189 MB). Users with no such memo never download or load it, and it unloads after an idle period.
- **Turn it off.** [Settings → AI](/user-guide/settings#ai) has a **Search voice memos by sound** switch
  under voice transcription. Off means no download and no audio embedding; memos are found by their
  transcript only. Existing audio vectors stay and keep answering searches. Turning it back on takes
  effect at the next vault open.
- **Existing vaults.** The first open after updating indexes your existing memos in the background,
  one at a time, and a quit part-way continues where it stopped. Nothing is reset and no vault file changes.
- **Why transcript first.** On Turkish and English recordings, a transcript vector found a spoken or
  typed description of a memo at least as often as the audio vector, and combining the two did no
  better. Audio is the only signal for a recording with no words, so that is where it is used.
- **Limits.** Matching sound to a word is looser than text to text, so audio hits need a similarity
  of about 0.68. Queries are typed text; speaking a query is not supported.

## Model Size

Models trade off accuracy vs disk and memory. The default is tuned for desktop hardware. The settings page shows dimensions and the current count of embedded notes.

## Reindexing

Rebuild the index after:

- Switching models
- Restoring a vault from backup
- A migration that touched note storage

**Rebuild Index** recalculates note embeddings. Existing vectors stay available until their
replacements are ready. If a note fails, its old vectors remain and the rebuild reports failure
rather than claiming every note is indexed. Opening the vault again or disabling and re-enabling
AI retries unfinished work.

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

Semantic search compares your query with stored vectors, but embedding a new query still runs the
local model. Importing many notes also starts background embedding work, even when sync is idle.

If you need to stop that work, turn AI off in settings. Rebuilding the index adds work; it is not a
way to reduce CPU usage during an import.

## Disabling Embeddings

Toggle **Enable** off to stop the embedding worker. Shutdown is bounded, including when a current
inference is stuck. The vector index stays on disk, and notes edited while AI is off remain marked
for indexing. Turning AI back on starts the catch-up pass without deleting valid vectors.

Search falls back to keyword-only while AI is off.

## See Also

- [Search & Command Palette](/user-guide/search)
- [Provider Setup](/user-guide/ai/provider-setup) — provider config for the inline AI menu (separate from embeddings)
