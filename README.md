<div align="center">

<!-- TODO: Replace with actual logo -->
<!-- <img src="assets/logo.png" width="80" alt="memry logo" /> -->

# memry

**Your thoughts. Your devices. Your control.**

A private, offline-first workspace for notes, journals, and tasks — with real-time sync that never sees your data.

<!-- TODO: Replace with actual hero screenshot or demo video -->
<!-- Recommended: 1200x720 screenshot showing the app in dark mode with a note open -->

[<!-- <img src="assets/hero-screenshot.png" width="720" alt="memry app screenshot" /> -->
`[ hero screenshot / demo video — 1200×720 ]`](https://memry.app)

[![Download for macOS](https://img.shields.io/badge/Download-macOS-000?style=for-the-badge&logo=apple&logoColor=white)](#download)
[![Download for Windows](https://img.shields.io/badge/Download-Windows-0078D4?style=for-the-badge&logo=windows&logoColor=white)](#download)
[![Download for Linux](https://img.shields.io/badge/Download-Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black)](#download)

</div>

---

Most note apps ask you to trust them with your thoughts. memry doesn't.

Everything you write is **encrypted on your device** before it ever leaves. Not even we can read it. Your notes sync across all your devices in real-time — but the servers only ever see encrypted noise.

No cloud lock-in. No subscription walls for basic features. No "oops, we got breached" emails. Just a fast, beautiful app that works whether you're online or off.

---

## What you get

<table>
<tr>
<td width="50%">

### Write freely

A distraction-free editor that stays out of your way. Rich text, markdown, wiki-style `[[links]]` between notes — connect ideas naturally.

<!-- TODO: Replace with editor screenshot -->
<!-- Recommended: 580x380 showing the editor with some formatted text and a wiki link -->

`[ editor screenshot — 580×380 ]`

</td>
<td width="50%">

### Think in connections

Every `[[link]]` creates a two-way connection. See what links back to any note. Watch your personal knowledge graph grow without effort.

<!-- TODO: Replace with backlinks/graph screenshot -->
<!-- Recommended: 580x380 showing backlinks panel or graph view -->

`[ backlinks screenshot — 580×380 ]`

</td>
</tr>
<tr>
<td width="50%">

### Journal daily

A dedicated space for daily reflection. Calendar view with activity streaks so you can see your consistency at a glance. Just open the app and start writing.

<!-- TODO: Replace with journal screenshot -->
<!-- Recommended: 580x380 showing journal with calendar heatmap -->

`[ journal screenshot — 580×380 ]`

</td>
<td width="50%">

### Track what matters

Tasks and projects live alongside your notes — not in a separate app. Priorities, due dates, drag-and-drop. Simple enough for groceries, structured enough for goals.

<!-- TODO: Replace with tasks screenshot -->
<!-- Recommended: 580x380 showing task board or list view -->

`[ tasks screenshot — 580×380 ]`

</td>
</tr>
</table>

---

## Sync without compromise

<div align="center">

<!-- TODO: Replace with sync diagram or animation -->
<!-- Recommended: 700x300 showing two devices syncing with a lock icon in between -->

`[ sync diagram / animation — 700×300 ]`

</div>

Most apps make you choose: **privacy** or **sync**. memry gives you both.

|                    | memry                                                           | Typical note apps                           |
| ------------------ | --------------------------------------------------------------- | ------------------------------------------- |
| **Encryption**     | End-to-end. We literally can't read your notes.                 | "Encrypted at rest" (they hold the keys)    |
| **Offline**        | Full functionality. No internet needed.                         | Degraded or broken without connection       |
| **Conflicts**      | Smart merge — edits from multiple devices combine automatically | Last save wins (your edits disappear)       |
| **Data ownership** | SQLite on your machine. Export anytime.                         | Proprietary format on someone else's server |

<details>
<summary><strong>How does the sync actually work?</strong></summary>

<br>

When you edit a note on one device, memry:

1. **Encrypts** the change locally using military-grade cryptography (XChaCha20-Poly1305 + Ed25519 signatures)
2. **Sends** the encrypted blob to the sync server — which stores it without being able to decrypt it
3. **Delivers** it to your other devices, where it's decrypted locally
4. **Merges** intelligently using CRDTs (Conflict-free Replicated Data Types) — the same tech behind Google Docs' real-time collaboration, but without Google seeing your data

Edit the same paragraph on your phone and laptop at the same time? memry merges both edits. No conflicts. No data loss.

</details>

---

## Built for speed

memry runs natively on your machine. Not a browser tab pretending to be an app.

- **Instant startup** — your notes are already there, in a local database
- **Works offline** — airplane mode? No Wi-Fi? No problem
- **Tabs, split panes, keyboard shortcuts** — built for how you actually work
- **Dark & light themes** — easy on the eyes, day or night

<div align="center">

<!-- TODO: Replace with speed/feature demo GIF or video -->
<!-- Recommended: 700x420 GIF showing tab switching, split pane, dark/light toggle -->

`[ app demo GIF — 700×420 ]`

</div>

---

## Privacy is not a feature. It's the architecture.

<div align="center">

```
 ┌──────────────┐          ┌──────────────┐          ┌──────────────┐
 │   Device A   │          │    Server    │          │   Device B   │
 │              │          │              │          │              │
 │  Your notes  │──────▶  │  ████████░░  │  ──────▶│  Your notes  │
 │  (readable)  │ encrypt  │  (garbage)   │ decrypt  │  (readable)  │
 └──────────────┘          └──────────────┘          └──────────────┘
                                  │
                                  ▼
                           Can't read it.
                          Can't sell it.
                         Can't hand it over.
```

</div>

Your encryption keys never leave your devices. The sync server is designed to be **zero-knowledge** — it helps your devices find each other, but it has no idea what you're writing.

Even if someone broke into the server, they'd get nothing but encrypted noise.

---

<div align="center">

## Get started

<!-- TODO: Replace with download links when ready -->

[![Download for macOS](https://img.shields.io/badge/Download-macOS-000?style=for-the-badge&logo=apple&logoColor=white)](#download)
[![Download for Windows](https://img.shields.io/badge/Download-Windows-0078D4?style=for-the-badge&logo=windows&logoColor=white)](#download)
[![Download for Linux](https://img.shields.io/badge/Download-Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black)](#download)

**Link your devices with a QR code. That's it.**

No account creation. No email verification. No password to forget.
Scan a code from your first device to your second, and they sync.

<!-- TODO: Replace with device linking screenshot or GIF -->
<!-- Recommended: 500x300 showing QR code device linking flow -->

`[ device linking flow — 500×300 ]`

</div>

---

<div align="center">

### memry is for people who think best when they're not worried about who's watching.

**[Download memry](#download)** · [Roadmap](#roadmap) · [Community](#community)

</div>

---

<details>
<summary><strong>Roadmap</strong></summary>

<br>

We're building in the open. Here's what's coming:

- [ ] Mobile apps (iOS & Android)
- [ ] Browser extension for quick capture
- [ ] AI-powered search across your notes (runs locally, of course)
- [ ] Shared vaults for teams
- [ ] Plugin system
- [ ] Self-hosted sync server option

Want to shape what comes next? [Join the conversation →](#community)

</details>

<details>
<summary><strong>For developers</strong></summary>

<br>

memry is built with:

- **Electron** + **React** + **TypeScript** for the desktop app
- **Yjs** CRDTs for conflict-free real-time collaboration
- **libsodium** for all cryptographic operations
- **SQLite** (via better-sqlite3 + Drizzle ORM) for local storage
- **Cloudflare Workers** + **D1** + **R2** for the sync backend
- **BlockNote** for the rich text editor

```bash
# Clone and run locally
git clone https://github.com/memry-app/memry.git
cd memry
pnpm install
pnpm dev
```

</details>

---

<div align="center">
<sub>Made with care for people who value their privacy.</sub>
</div>
