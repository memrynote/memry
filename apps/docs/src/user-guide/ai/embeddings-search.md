# Embeddings & Semantic Search

Run a local embedding model so search ranks by meaning, not just keywords.

<!-- screenshot: embeddings model status in settings with progress -->

## What This Powers

When embeddings are loaded, Memry can rank notes by **semantic similarity** to your query — not just keyword overlap. This affects:

- The [search palette](/user-guide/search) (semantic boost on top of keyword match)
- **AI Connections** in the [Journal](/user-guide/journal/daily-entries) sidebar
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
- **Error** — see logs; usually disk space or hash mismatch

You can **Unload** the model from settings to free memory; reload as needed.

## Model Size

Models trade off accuracy vs disk and memory. The default is tuned for desktop hardware. The settings page shows dimensions and the current count of embedded notes.

## Reindexing

Rebuild the index after:

- Switching models
- Restoring a vault from backup
- A migration that touched note storage

Reindexing is incremental — Memry skips notes whose content hash hasn't changed.

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
