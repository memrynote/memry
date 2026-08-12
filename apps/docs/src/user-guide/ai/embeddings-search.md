# Embeddings & Semantic Search

Run a local embedding model so search ranks by meaning, not just keywords.

<!-- screenshot: embeddings model status in settings with progress -->

## What This Powers

When embeddings are loaded, memrynote can rank notes by **semantic similarity** to your query — not just keyword overlap. This affects:

- The [search palette](/user-guide/search) (semantic boost on top of keyword match)
- "Related notes" suggestions in some surfaces

A query like "setting up authentication" can surface a note titled "OAuth flow" even when the words don't overlap.

## Enabling

1. Open [Settings → AI](/user-guide/settings#ai)
2. Toggle **Enable**
3. Under Embedding Model, click **Download** to pull the model
4. Wait for the status to say **Loaded**
5. Click **Rebuild Index** to embed every existing note (one-time per model)

The first index build can take a few minutes for large vaults — progress is shown.

## Model Management

The status line shows:

- **Loaded** — ready
- **Loading** — initialization in progress
- **Not downloaded** — needs download
- **Error** — see logs; usually disk space, a hash mismatch, or a failed download

You can **Unload** the model from settings to free memory; reload as needed.

### When the Download Fails

The model is fetched once (~23MB). If that download fails — you are offline, behind a proxy, or the
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

## Performance

Once the index is built, semantic search adds <50ms to a typical query. Embedding is the expensive step (one-time per note); ranking is cheap.

If you have an enormous vault and notice slowdowns, the index can be rebuilt fresh in settings.

## Disabling Embeddings

Toggle **Enable** off. The model unloads. The vector index stays on disk (you can delete the file manually if you want it gone).

Search falls back to keyword-only — fast, but less forgiving of varied phrasing.

## See Also

- [Search & Command Palette](/user-guide/search)
- [Provider Setup](/user-guide/ai/provider-setup) — provider config for the inline AI menu (separate from embeddings)
