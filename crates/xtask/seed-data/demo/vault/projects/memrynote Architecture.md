---
tags:
  - projects/memry
  - architecture
project:
  - memrynote Launch
area: Work
status: active
priority: high
deadline: '2026-12-14'
owner: Kaan
---
## Boundaries

- **Renderer** — React 19, no Node access
- **Main** — Electron, owns SQLite + Y.Docs
- **Sync** — Cloudflare Workers + D1 + R2; never sees plaintext
- **Contracts** — Zod-typed IPC + API

See [[CRDT Architecture]] and [[Drizzle ORM]] for the data layer.

## Why Electron

Local-first means *all* data is on disk. Browser sandbox is a non-starter.

#projects/memry #architecture
