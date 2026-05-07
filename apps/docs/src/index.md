---
layout: home

hero:
  name: Memry
  text: Private notes, journals, and tasks.
  tagline: An offline-first workspace with end-to-end encrypted sync. Your data starts and stays on your device.
  actions:
    - theme: brand
      text: Install Memry
      link: /guide/install
    - theme: alt
      text: Take a Tour
      link: /guide/tour
    - theme: alt
      text: User Guide
      link: /user-guide/notes/editing

features:
  - title: Local-first by default
    details: Your workspace lives in a local SQLite vault. Notes, journals, and tasks keep working offline.
  - title: End-to-end encrypted sync
    details: Devices encrypt before upload. The Cloudflare-backed sync server stores ciphertext only.
  - title: Notes, journal, and tasks together
    details: Capture ideas, daily reflections, projects, and tasks in one private workspace.
  - title: Yjs CRDT for notes
    details: Concurrent edits across devices merge cleanly. Your writing flow survives flaky networks.
  - title: Field-level merge for tasks
    details: Per-field vector clocks let you and another device edit the same task without losing changes.
  - title: Open source
    details: GPL v3.0. Built in the open with a thorough architecture and contributor guide.
---

## What is Memry?

Memry is a private workspace for people who want their notes, journals, tasks, and linked
ideas in one local-first app. The vault lives on your device. Sync is end-to-end encrypted,
so the server can never read your content.

Memry is under active development. The docs cover everything that's shipped, where it lives
in the app, and how to set it up.

## Where to start

- **New to Memry?** Read [Install Memry](/guide/install) and [First Run & Vault Setup](/guide/first-run), then take [A Tour of Memry](/guide/tour).
- **Want to know what it does?** Browse the [User Guide](/user-guide/notes/editing) — every feature has its own page.
- **Curious how it works?** See [Architecture](/architecture).
- **Want to contribute?** Start with [Contributing](/contributing).
