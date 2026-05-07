# How Sync Works

Memry sync is end-to-end encrypted. The server stores ciphertext and never sees note content.

<!-- screenshot: sync status indicator in the app chrome -->

## Status Indicator

A small indicator shows the current state: idle, syncing, paused, error.

## Pause / Resume

Pause sync from the indicator menu when working offline or troubleshooting. Resume to push and pull queued changes.

## What Gets Synced

- Notes (Yjs CRDT)
- Journal entries
- Tasks (field-level vector clocks)
- Projects
- Inbox items
- Templates
- Settings (selected, opt-in)

## What Does Not Get Synced

- Local app state (open tabs, sidebar collapse)
- Cached AI models and embeddings
- Voice and AI provider keys

## Frequency

Sync runs continuously while the app is open and online, with backoff during errors.
