---
tags:
  - projects/memry
  - mobile
  - architecture
project:
  - memrynote Launch
area: Work
status: active
priority: high
deadline: '2027-03-30'
owner: Kaan
platform: iOS + Android
energy: deep
reviewOn: '2026-11-29'
shared: true
---
The desktop app is where the vault lives. The phone is where the thought *arrives* — in a queue, on a walk, ten seconds before it evaporates. This note is the whole plan for closing that gap.

## Why a phone app at all

> [!info]
> Capture in under three seconds, or it is not capture. Every decision below is downstream of that one number.

- Capture first, edit second — the desktop keeps the editing crown
- Read the entire vault offline, on a plane, with no account check
- Never the place where a note gets damaged

## Stack

| Layer | Choice | Why |
| ----- | ------ | --- |
| Runtime | Expo SDK 54 | EAS builds, OTA updates, no Xcode babysitting |
| Language | TypeScript strict | Shares `packages/contracts` with desktop |
| Storage | expo-sqlite + FTS5 | Same schema shape as the desktop data DB |
| Crypto | libsodium (RN) | XChaCha20-Poly1305, byte-identical to desktop |
| UI | React Native + Reanimated | 120 Hz gestures, native feel |

### Runtime

- Expo Router — file-based navigation, deep links for free
- Hermes engine, bytecode precompiled at build time
- Dev client, never Expo Go: native modules are the whole point

### Data

- Drizzle schema mirrored from desktop, migrations hand-written
- Field-level vector clocks for tasks — see [[CRDT Architecture]]
- FTS5 index rebuilt incrementally, never on cold start

### UI

- Tokens ported from [[memrynote Architecture]]
- Logical properties everywhere — RTL from day one
- One accent, no gradients, no shadow deeper than 8dp

## Architecture

The phone is a **peer**, not a client. It talks to the same sync server every desktop install talks to, and it holds the same encrypted bytes.

### Boundaries

- **Screens** — Expo Router routes, zero direct DB access
- **Stores** — one Zustand store per domain
  - Selectors are the only read path
  - No store reads another store
- **Repos** — the only code that touches SQLite
- **Sync** — a background task, pull then push

### The sync seam

```ts
// mobile/src/sync/pull.ts
export async function pull(vaultId: string, since: Cursor): Promise<PullResult> {
  const page = await api.pull({ vaultId, since, types: SUPPORTED_TYPES })
  for (const item of page.items) {
    const plain = await decrypt(item.payload, await vaultKey(vaultId))
    await repo(item.type).upsert(plain)
  }
  return { cursor: page.cursor, applied: page.items.length }
}
```

- The pull cursor is per vault, per type
- Payloads land in SQLite; note bodies decrypt lazily on open
- A rejected item is recorded as `skipped` — never retried blindly, because blind retry is how one malformed timestamp becomes a permanent sync loop

### Offline and storage

1. Every screen reads from SQLite, always
2. The network only ever *fills* the database
3. A failed sync is a banner, never a blocked screen

- Attachment cache capped at 512 MB, LRU eviction
- Bodies over 4 MB are fetched on demand, not on sync
- Cold start never waits on a request

### Performance budget

| Metric | Budget | Measured on |
| ------ | ------ | ----------- |
| Cold start → first paint | 400 ms | Release build, iPhone 12 |
| Note open, cached | 80 ms | In-app instrumentation |
| Search keystroke → results | 50 ms | FTS5, 5k notes |
| Full sync, 1k notes | 20 s | Wi-Fi, staging server |

> A budget nobody measures is a wish. These four numbers go on the dashboard before the first beta build ships.

## Editor on device

<details data-memry-toggle open>
<summary>Why not render BlockNote natively?</summary>

- The block schema is 30+ custom blocks; porting them twice is two products
- A WebView bridge keeps one schema, one serializer, one bug surface
- Read mode stays native, so most sessions never touch the WebView

</details>

- **Read mode** renders markdown natively — instant, no WebView cost
- **Edit mode** loads the shared web editor behind a typed bridge
- The bridge speaks the same block JSON the desktop writes to disk

## Tables you can actually work in

The table work landed on desktop before mobile started, so the phone inherits all of it. Put images in cells, colour cells, and reach the row, column and cell menus from handles on the border lines. Add and remove rows and columns from the keyboard. Drag across cells and you select just those cells instead of grabbing the whole table. A column width you dragged survives reopening the note.

<!-- table-colors:{"0:0":{"textColor":"blue"},"0:1":{"textColor":"blue"},"0:2":{"textColor":"blue"},"0:3":{"textColor":"blue"},"1:2":{"backgroundColor":"green"},"2:2":{"backgroundColor":"yellow"},"3:2":{"backgroundColor":"red"},"3:3":{"textColor":"red"}} -->
<!-- table-layout:{"columnWidths":[200,170,130,null]} -->
| Screen | Preview | Status | Owner |
| ------ | ------- | ------ | ----- |
| Notes list | ![Notes list](https://images.unsplash.com/photo-1512941937669-90a1b58e7e9c?auto=format&fit=crop&w=200&q=60) | Shipped | Native list |
| Capture sheet | ![Capture sheet](https://images.unsplash.com/photo-1585060544812-6b45742d762f?auto=format&fit=crop&w=200&q=60) | In review | Native + keyboard |
| Note editor | ![Note editor](https://images.unsplash.com/photo-1510557880182-3d4d3cba35a5?auto=format&fit=crop&w=200&q=60) | Blocked | WebView bridge |

### What the handles do

- **Row handle** — insert above or below, delete the row, colour the whole row
- **Column handle** — insert left or right, delete the column, drag the edge to resize
- **Cell menu** — text colour, background colour, clear formatting
  - Opens from the border line, so it never covers the cell you are editing
  - The same menu on phone, opened by long-press instead of hover

### From the keyboard

| Action | Shortcut |
| ------ | -------- |
| Row below | Cmd + Enter |
| Row above | Cmd + Shift + Enter |
| Column right | Cmd + Shift + = |
| Delete row or column | Cmd + Backspace |

### What survived the round trip

- [x] Cell colours, written as a `table-colors` marker line
- [x] Column widths, written as a `table-layout` marker line
- [x] Images inside cells, as plain `![alt](src)` a phone can render
- [ ] Merged cells — parked, the markdown form is not settled yet

> [!success]
> Every one of those is a marker line a plain markdown reader ignores. Nothing about the file format changed — the vault stays portable.

<details data-memry-toggle>
<summary>Why the widths live in a marker line</summary>

BlockNote's markdown serializer drops `columnWidths` entirely, so a dragged width has nowhere to live in GFM. The marker sits on the line above the table, is ignored by every other markdown reader, and comes back onto the block on parse — the same trick the callout and alignment markers use.

</details>

## Screens

### Notes

- Folder tree, same row contract as the desktop sidebar
- Row = emoji + title + one-line snippet
- Swipe to file, long-press for the action sheet

### Capture

- Opens straight into the keyboard, no chrome
- Voice memo → transcript → inbox item
- Share-sheet target from any app on the phone

### Tasks

- Today · Upcoming · Done
- The checkbox writes markdown, not a DB flag — see [[memrynote Launch]]

### Settings

- Vault, sync, appearance, about
- Face ID lock, shipped off by default

## Release plan

- [x] Expo shell, navigation, design tokens
- [x] Read-only vault browsing
- [x] Sync pull path against staging
- [ ] Capture + inbox
- [ ] Push path for tasks and journals
- [ ] TestFlight beta — see [[memrynote Roadmap]]
- [ ] App Store review pass
- [ ] Android build on the same binary contract

## Risks

> [!warning]
> The WebView editor is the single largest bet in this plan. If the bridge feels laggy on a three-year-old Android, read mode has to carry the product alone until v2.

<details data-memry-toggle>
<summary>Quieter risks worth writing down</summary>

- Background sync on iOS is a suggestion, not a schedule
- Keychain migration across reinstalls can lose the vault key
- Two stores means two review queues on every release day — see [[Electron Gotchas]] for the desktop version of this pain

</details>

## Open questions

1. Does capture live in the app, or in a widget and share sheet only?
2. Android at launch, or six weeks behind iOS?
3. Is mobile a separate tier, or bundled with the desktop plan? — [[memrynote GTM]]

## Links

- Parent project: [[memrynote Launch]]
- Long game: [[memrynote Roadmap]]
- Data layer: [[CRDT Architecture]] and [[Drizzle ORM]]
- Native build pain, desktop edition: [[Electron Gotchas]]
- Review notes: [[2026-11-25]]

#projects/memry #mobile #active
