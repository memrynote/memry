<div align="center">

<img src="apps/landing/public/favicon.svg" width="96" alt="Memry logo" />

# Memry

**Your second brain — offline-first, end-to-end encrypted, agent-native.**

Notes, tasks, projects, journal, calendar, and an AI agent that actually has context on your work. All on your machine. None of it on someone else's server.

[![Release](https://img.shields.io/github/v/release/memrynote/memry?include_prereleases&sort=semver)](https://github.com/memrynote/memry/releases)
[![CI](https://github.com/memrynote/memry/actions/workflows/ci.yml/badge.svg)](https://github.com/memrynote/memry/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/memrynote/memry/branch/main/graph/badge.svg)](https://codecov.io/gh/memrynote/memry)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Standard Readme](https://img.shields.io/badge/readme%20style-standard-brightgreen.svg)](https://github.com/RichardLitt/standard-readme)
[![Electron](https://img.shields.io/badge/built%20with-Electron-47848F.svg)](https://www.electronjs.org/)
[![React 19](https://img.shields.io/badge/React-19-61DAFB.svg)](https://react.dev/)

[Website](https://memrynote.com) · [Docs](https://docs.memrynote.com) · [Download](https://memrynote.com/download/desktop)

</div>

---

Hi — I'm **[Kaan](https://x.com/h4yfans)**, the developer behind Memry. For years I bounced between four apps just to get through the day — inbox in one, calendar in another, notes somewhere else, tasks in a fourth — and with ADHD that constant jumping around drained me before I'd even started working. I wanted one calm place that held all of it: inbox, notes, daily journal, tasks, projects, calendar, and an AI agent that actually knows what I'm working on. And because not everyone needs every piece, every feature is a toggle — don't use a calendar? Turn it off. Not into AI? Turn that off too. Memry is the app I wish I'd had years ago, so I shipped it myself.

> _Screenshot: Memry's main workspace — notes, sidebar, agent chat side-by-side._
>
> `<!-- TODO: drop screenshot here -->`

## Table of Contents

- [Why Memry](#why-memry)
- [Features](#features)
- [Screenshots](#screenshots)
- [Install](#install)
- [Build from Source](#build-from-source)
- [Roadmap](#roadmap)
- [Community](#community)
- [License](#license)

## Why Memry

Most note apps want to be a SaaS. Your knowledge ends up on their servers, hostage to their pricing tiers, their outages, and their AI training data pipelines.

Memry is the opposite bet:

- **Local-first.** Your vault lives on disk. Works offline. Always.
- **End-to-end encrypted sync.** XChaCha20-Poly1305 + Ed25519 + Argon2id. The server stores ciphertext blobs it can't read.
- **Agent-native.** Bring your own model — Claude CLI, Codex CLI, local LLMs, or OpenAI-compatible endpoints. The agent gets read/write access to your vault through a localhost MCP server.
- **One app, six surfaces.** Notes, tasks, projects, daily journal, calendar, inbox — instead of stitching seven tools together.

Built for people who want Obsidian's local-first ethos, Notion's range, and an AI that actually knows what they're working on.

## Features

### Notes

Block-based editor. Markdown round-trip. Backlinks. Tags. Wiki-style search. Files on disk, not in a database you can't migrate out of.

### Tasks & Projects

Real task management — due dates, priorities, projects, recurrence — without a separate app. Field-level CRDT merge means edits on two devices don't blow each other away.

### Daily Journal

One file per day. Templates. Frontmatter. Quick capture. The kind of journal you'll actually keep, because it's three keystrokes to open.

### Calendar

Time-block your tasks. See your day at a glance. Drag to reschedule.

### Inbox

Capture first, organize later. Email-yourself-a-note, but to your own vault.

### AI Agent

Talk to your vault. The agent can read, draft, refactor, and link notes across the whole workspace. Approval UI for writes. Switch providers per conversation. Reasoning level and model are conversation settings, not buried in preferences.

### Sync

Optional, end-to-end encrypted, running on Cloudflare Workers + R2. Multi-device. Conflict resolution via CRDTs for notes/journals and per-field vector clocks for tasks/projects. The server is a ciphertext relay — sign out and your data is unreadable to anyone but you.

## Screenshots

> _Screenshot: Notes view with backlinks panel._
>
> `<!-- TODO: notes-view.png -->`

> _Screenshot: Tasks board with calendar peek._
>
> `<!-- TODO: tasks-board.png -->`

> _Screenshot: Daily journal with templates._
>
> `<!-- TODO: journal.png -->`

> _Screenshot: AI Agent chat with vault context and approval UI._
>
> `<!-- TODO: agent-chat.png -->`

> _Screenshot: Calendar view with task time-blocking._
>
> `<!-- TODO: calendar.png -->`

## Install

### Download

Grab the latest desktop build for your platform:

- **macOS** (Apple Silicon + Intel) → [memrynote.com/download/desktop](https://memrynote.com/download/desktop)
- **Windows** → [memrynote.com/download/desktop](https://memrynote.com/download/desktop)
- **Linux** (AppImage, deb) → [memrynote.com/download/desktop](https://memrynote.com/download/desktop)

No signup. No telemetry-on-by-default. Open the app, pick a vault folder, start writing.

### Build from Source

Requires Node 20+ and pnpm 9+.

```bash
git clone https://github.com/memrynote/memry.git
cd memry
pnpm install
pnpm dev
```

That's it. The Electron app launches with hot reload.

For the landing site, docs, or sync server, see [CLAUDE.md](CLAUDE.md).

## Roadmap

- Mobile (iOS / Android) with full E2E sync parity
- Plugin API
- Public vault sharing (encrypted, view-only)
- More agent backends (Ollama, llama.cpp, Mistral)

## Community

- **Twitter / X**: [@memrynote](https://twitter.com/memrynote)
- **Discord**: [discord.gg/memry](https://discord.gg/memry)
- **GitHub Issues**: bugs, feature requests, weird ideas
- **Email**: hi@memrynote.com

If you ship a workflow you love, tell us. If something is broken, tell us louder.

---

## Star History

[![Star History Chart](https://api.star-history.com/image?repos=memrynote/memry&type=date&legend=top-left)](https://www.star-history.com/?repos=memrynote%2Fmemry&type=date&legend=top-left)

---

<div align="center">
<sub>Private by design, open at heart.</sub>
</div>

## License

MIT © Memry contributors

See [LICENSE](LICENSE) for the legal text.
