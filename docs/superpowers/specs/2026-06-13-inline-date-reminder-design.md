# Inline Date / Reminder Mention — Design

Date: 2026-06-13
Branch: `feat/inline-reminder`
Status: Draft — awaiting review

## Goal

Let a user drop a date into a note's text and optionally attach a reminder to it,
the way Notion does. Typing `/date` inserts an inline date pill at the cursor and
opens a picker. The date always carries calendar value; a reminder is opt-in. When
a reminder fires, the note lands in the Inbox; clicking that Inbox item opens the
note and scrolls to (and focuses) the exact date pill.

Reference: https://www.notion.com/help/reminders

## User flows

1. **Insert** — In a note, type `/date` → slash-menu item "Date" → inserts inline
   pill at cursor, opens picker popover (date, optional time).
2. **Bare date** — User picks a date, no reminder. Pill renders `📅 Jun 20`. Shows
   in the Calendar (Phase 2), never notifies.
3. **Reminding date** — User toggles "Remind me" + lead time (`at time`, `5 min`,
   `1 hour`, `1 day` before). Pill renders `📅 Jun 20, 9:00 🔔`. A local reminder
   row is derived from the pill; the scheduler fires it.
4. **Fire** — At `remindAt`, the existing scheduler creates a `reminder` Inbox item.
5. **Open** — Click the Inbox item → open the note, scroll to the pill, focus it.
6. **Edit / remove** — Re-open the pill popover to change date/time/lead or clear
   the reminder. Deleting the pill (or the note) removes the derived reminder.

## Key constraint that drives the design

`reminder` is **not** a synced item type. `SYNC_ITEM_TYPES`
(`packages/contracts/src/sync-api.ts`) covers note/task/journal/calendar/inbox/etc.
but not reminders — reminder rows are local-to-device today. Only `note` syncs as
CRDT. Therefore the durable, cross-device record of a date+reminder must live in the
note body (which syncs), and reminder rows must be a **local derived index**,
rebuilt on each device from note content — exactly how the app already treats
reminders.

## Architecture — Approach A (approved)

**The inline date pill is the single source of truth. Reminder rows + calendar
entries are derived per-device.**

```
note body (CRDT, synced)                     local, derived (per device)
┌───────────────────────────┐   derive      ┌────────────────────────────┐
│ dateMention inline node    │ ───────────▶  │ reminders row              │
│  anchorId, dateISO,        │   on note     │  targetType 'note_date'    │
│  hasTime, remind, lead     │   change      │  targetId = noteId         │
└───────────────────────────┘               │  anchorId, remindAt        │
                                             └─────────────┬──────────────┘
                                                           │ existing scheduler
                                                           ▼
                                              reminder Inbox item ──▶ click ──▶
                                              open note + scroll to anchorId
```

Rejected alternatives:

- **B (reminder row = source of truth, pill stores reminderId):** breaks on a 2nd
  device — the synced pill references a reminder row that doesn't exist there.
  Two-entity lifecycle, orphans on delete.
- **C (scheduler scans note bodies directly, no rows):** bypasses the whole existing
  reminder → inbox → calendar machinery; large rework.

## Components & files

### 1. Editor element — `dateMention` inline content

- New: `note/content-area/date-mention.tsx` (+ utils/test), modeled on
  `wiki-link.tsx` / `link-mention.ts`.
- Register in `note/content-area/editor-schema.ts` under `inlineContentSpecs`.
- Props: `anchorId: string` (stable uuid), `dateISO: string`, `hasTime: boolean`,
  `remind: boolean`, `lead: 'at' | '5m' | '1h' | '1d'`.
- Render: pill with calendar glyph + formatted date (+ time) + bell when `remind`.
  `data-anchor-id={anchorId}` on the DOM node for scroll-to.
- Click → popover: date/time picker + "Remind me" toggle + lead `<select>`.
  Reuse existing date-picker primitives; mock per the Picker-in-jsdom convention in
  renderer tests.

### 2. Slash-menu item `/date`

- Add a "Date" item following the `getTaskSlashMenuItem` pattern wired in
  `ContentArea` `getItems` (group "Basic blocks"; keep groups contiguous via the
  existing `orderSlashMenuItemsByGroup` helper). Inserts the inline node at cursor
  with a fresh `anchorId` and opens the popover.

### 3. Persistence / markdown serialization

- `dateMention` serializes to a stable inline token (same approach as `wikiLink`)
  in **both** serializers — renderer `markdown-utils.ts` **and** main
  `blocknote-converter.ts` (they are duplicated; both must round-trip). Token must
  encode `anchorId`, `dateISO`, `hasTime`, `remind`, `lead`.
- Add round-trip test blocks to both serializer test suites.

### 4. Note → reminder derive bridge (the new glue)

- New module (main process, near sync/notes write path) that, on note
  create/update, extracts `dateMention` nodes and diffs them against existing
  `note_date` reminder rows for that note:
  - new reminding pill → create reminder row;
  - changed date/lead/remind → update or delete row;
  - pill removed / `remind:false` → delete row;
  - note deleted → delete all `note_date` rows for that note.
- `remindAt = dateISO − lead`. Bare dates (`remind:false`) produce **no** reminder
  row (calendar-only in Phase 2).
- Runs through `RemindersService` (`packages/app-core/src/reminders.ts`); no new
  scheduler — the existing due/scheduler path consumes the rows.

### 5. Data model

- `packages/contracts/src/reminder-types.ts`: add `note_date` to the
  `reminderTargetType` map. Propagate the new value everywhere the union is
  re-declared (known drift: `packages/rpc/src/inbox.ts`,
  `apps/desktop/src/preload` reminder API types, `cli/run.ts`) — see the
  ReminderTargetType consolidation note.
- `packages/db-schema/src/schema/reminders.ts`: add nullable `anchorId text`
  column (points at the exact pill). Pre-production: schema is resettable
  (`db:generate` + `db:push`).
- `ReminderEntryNav` (`renderer/src/lib/reminder-panel.ts`) gains optional
  `anchorId`; carried through `ReminderMetadata` → `metadataToNav`.

### 6. Inbox + scroll-to (mostly existing)

- Firing reuses the current scheduler → `reminder` Inbox item path (Inbox already
  has `type: 'reminder'`, `captureSource: 'reminder'`, `markViewed`).
- Navigation: `use-block-note-setup.ts` already consumes `ReminderEntryNav` to
  scroll to a highlight offset. Extend it: when `anchorId` is present, scroll to
  `[data-anchor-id="…"]` and place the cursor in that node (more robust than char
  offsets under CRDT edits).

### 7. Calendar — Phase 2 (fast-follow)

- Surface `note_date` rows (both bare and reminding) as **read-only** calendar
  entries; click → open note at the pill. Exact calendar-source wiring to be
  pinned during planning (the least-explored area). Not required for MVP.

## Scope

**MVP:** `/date` slash item, `dateMention` pill + picker popover, remind toggle +
lead, markdown round-trip (both serializers), note→reminder derive, fire → Inbox,
click → scroll-to-anchor. New `note_date` target type, `anchorId` column, nav
plumbing.

**Non-goals (now):** recurring reminders; natural-language typing (reuse
`natural-date-parser.ts` later); timezone selection; editing rules for already-fired
dates; the Calendar entry (Phase 2).

## Testing

- **Unit**
  - `dateMention` markdown round-trip in renderer `markdown-utils` and main
    `blocknote-converter` suites.
  - Derive-diff: add / change / remove pill → correct row create/update/delete;
    `remind:false` → no row; note delete → rows cleared.
  - `remindAt = dateISO − lead` for each lead value.
- **Integration**
  - Reminding pill → scheduler → `reminder` Inbox item with `anchorId` in nav.
  - Click Inbox item → correct note opens and scrolls to the anchor.
- **Renderer**
  - Picker popover via the Picker-mock convention; pill renders bell only when
    `remind`.

## Risks / open questions

- **Serializer duplication** — both `markdown-utils.ts` and `blocknote-converter.ts`
  must encode the token identically or round-trips drift. Covered by tests in both.
- **Derive trigger point** — must run on every note write (local edit and inbound
  CRDT sync apply) so a synced pill produces a reminder row on the receiving
  device. Confirm the single chokepoint during planning.
- **anchorId uniqueness** — generated at insert; copy/paste of a pill could
  duplicate an `anchorId`. Mitigation: regenerate `anchorId` on paste, or dedupe in
  the derive step (last-write-wins per anchorId).
- **Calendar wiring (Phase 2)** — calendar entry source for note-dates not yet
  read; scoped out of MVP intentionally.
