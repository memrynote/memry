# Memry Speckit Prompts

This folder contains structured prompts for use with [Speckit](https://github.com/github/spec-kit) to build Memry's backend.

## Overview

Memry is a local-first, end-to-end encrypted PKM (Personal Knowledge Management) application. These prompts define the specifications for:

- **Core Architecture**: Local-first, vault-based storage, E2E encryption
- **Features**: Notes, Tasks, Journal, Inbox, Search, AI Assistant
- **Backend**: Sync server, encryption layer, database design

## Prompt Files

| File | Speckit Command | Purpose |
|------|-----------------|---------|
| `00-constitution.md` | `/speckit.constitution` | Project principles and standards |
| `01-specify-core-data.md` | `/speckit.specify` | File system & SQLite data layer |
| `02-specify-tasks.md` | `/speckit.specify` | Task management system |
| `03-specify-notes.md` | `/speckit.specify` | Note-taking with wiki links |
| `04-specify-journal.md` | `/speckit.specify` | Daily journaling system |
| `05-specify-inbox.md` | `/speckit.specify` | Quick capture & inbox |
| `06-specify-sync.md` | `/speckit.specify` | Sync engine & E2E encryption |
| `07-specify-search.md` | `/speckit.specify` | Search & discovery |
| `08-specify-settings.md` | `/speckit.specify` | Settings & preferences |
| `09-specify-ai-assistant.md` | `/speckit.specify` | AI-powered features |
| `10-plan-backend.md` | `/speckit.plan` | Tech stack & implementation plan |

## Execution Order

### Recommended sequence:

```bash
# 1. First, establish project principles
/speckit.constitution
# Copy content from 00-constitution.md

# 2. Create feature specifications (in dependency order)
/speckit.specify  # Core data layer (01)
/speckit.specify  # Tasks (02)
/speckit.specify  # Notes (03)
/speckit.specify  # Journal (04)
/speckit.specify  # Inbox (05)
/speckit.specify  # Sync (06)
/speckit.specify  # Search (07)
/speckit.specify  # Settings (08)
/speckit.specify  # AI Assistant (09)

# 3. Create implementation plan
/speckit.plan
# Copy content from 10-plan-backend.md

# 4. Generate tasks from specs
/speckit.tasks

# 5. Start implementation
/speckit.implement
```

## Architecture Summary

```
┌─────────────────────────────────────────────────────────────────┐
│                         MEMRY ARCHITECTURE                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    ELECTRON APP                           │   │
│  │  ┌────────────────────┐    ┌────────────────────────┐   │   │
│  │  │   Main Process     │    │   Renderer Process     │   │   │
│  │  │                    │    │                        │   │   │
│  │  │  ┌──────────────┐  │◄──►│  React + TypeScript   │   │   │
│  │  │  │ SQLite       │  │IPC │  shadcn/ui            │   │   │
│  │  │  │ (better-     │  │    │  BlockNote            │   │   │
│  │  │  │  sqlite3)    │  │    │  @dnd-kit             │   │   │
│  │  │  └──────────────┘  │    └────────────────────────┘   │   │
│  │  │                    │                                  │   │
│  │  │  ┌──────────────┐  │                                  │   │
│  │  │  │ File Watcher │  │                                  │   │
│  │  │  │ (chokidar)   │  │                                  │   │
│  │  │  └──────────────┘  │                                  │   │
│  │  │                    │                                  │   │
│  │  │  ┌──────────────┐  │                                  │   │
│  │  │  │ Encryption   │  │                                  │   │
│  │  │  │ (libsodium)  │  │                                  │   │
│  │  │  └──────────────┘  │                                  │   │
│  │  └────────────────────┘                                  │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│                              │ Encrypted                         │
│                              ▼                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    SYNC SERVER                            │   │
│  │              (Cloudflare Workers + R2)                    │   │
│  │                                                           │   │
│  │  • OAuth (Google, Apple, GitHub)                         │   │
│  │  • Encrypted blob storage                                │   │
│  │  • Device management                                     │   │
│  │  • Push/pull sync                                        │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│                              │ Encrypted                         │
│                              ▼                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    MOBILE APP                             │   │
│  │              (React Native + Expo)                        │   │
│  │                                                           │   │
│  │  • Same encryption                                       │   │
│  │  • Selective sync                                        │   │
│  │  • Share sheet integration                               │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                         VAULT STRUCTURE                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  vault/                      # User-selected location            │
│  ├── notes/                  # Markdown files with frontmatter   │
│  │   ├── meeting-notes.md                                       │
│  │   └── project-plan.md                                        │
│  ├── journal/                # Daily entries (YYYY-MM-DD.md)     │
│  │   ├── 2024-01-15.md                                          │
│  │   └── 2024-01-16.md                                          │
│  ├── attachments/            # Images, voice recordings, files   │
│  │   ├── image-abc123.png                                       │
│  │   └── voice-def456.m4a                                       │
│  └── .memry/                 # Hidden app data                   │
│      ├── index.db            # SQLite cache (rebuildable)        │
│      ├── data.db             # Tasks, projects, settings         │
│      └── sync-state/         # Sync queue and versions           │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Key Principles

1. **Local-First**: Works fully offline, sync is optional enhancement
2. **E2E Encrypted**: Server never sees plaintext data
3. **No Vendor Lock-in**: Files are plain markdown, exportable anytime
4. **Privacy by Design**: Minimal metadata exposure, even to our servers

## Tech Stack Summary

### Frontend (Existing)
- Electron + electron-vite
- React 19 + TypeScript
- Tailwind CSS + shadcn/ui
- BlockNote (rich text editor)
- @dnd-kit (drag and drop)

### Backend (To Build)
- better-sqlite3 (local database)
- chokidar (file watching)
- libsodium-wrappers (encryption)
- keytar (keychain access)
- bip39 (recovery phrase)

### Sync Server
- Hono.js on Cloudflare Workers
- Cloudflare R2 (blob storage)
- Cloudflare D1 (user metadata)
- OAuth (Google, Apple, GitHub)

### Mobile (Future)
- React Native + Expo
- expo-sqlite
- Same encryption library

## Implementation Timeline

| Phase | Focus | Duration |
|-------|-------|----------|
| 1 | Core Data Layer | 2 weeks |
| 2 | Task Backend | 2 weeks |
| 3 | Notes & Journal | 2 weeks |
| 4 | Encryption | 2 weeks |
| 5 | Sync Server | 3 weeks |
| 6 | Sync Client | 3 weeks |
| 7 | Inbox | 2 weeks |
| 8 | Search & AI | 3 weeks |
| 9 | Settings & Polish | 2 weeks |
| 10 | Mobile App | 4+ weeks |

**Total: ~25 weeks** (6 months) for full feature set

## Contributing

When adding new prompts:
1. Follow the numbered naming convention
2. Include user stories with priorities (P1/P2/P3)
3. Define clear data models
4. List acceptance criteria
5. Consider edge cases
