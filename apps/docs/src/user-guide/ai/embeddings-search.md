# Embeddings & Semantic Search

Run a local embedding model so search ranks by meaning, not just keywords.

<!-- screenshot: embeddings model status in settings -->

## What This Powers

- Semantic ranking in [Search](/user-guide/search)
- AI Connections in [Journal](/user-guide/journal/daily-entries)

## Enabling

Toggle "Enable AI" in [Settings → AI](/user-guide/settings#ai). Pick an embedding model and load it.

## Model Management

Models are downloaded once and cached locally. Unload to free memory.

## Reindexing

Reindex after enabling embeddings for the first time, or after switching models. Progress shows in settings.

## Privacy

Embeddings are computed on-device. Vectors are stored in the local index database and are never sent to a server.
