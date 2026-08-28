# Feature Specification: Memry Mobile — Vault Parity Mobile App

**Feature Branch**: `001-mobile-app`

**Created**: 2026-08-22

**Status**: Draft

**Input**: User description: "Amacımız, mevcut desktop uygulamasının mobil versiyonunu yapmaktır. Bu mobil versiyonun, mevcut elektron uygulamasının ana özelliklerinin hepsini ilk günden desteklemesi gerekmektedir: notlar, görevler (tasks), günlük (journal), takvim (calendar), gelen kutusu (inbox), ana sayfa (home), canvas. Bu özelliklerin alt özelliklerinin de hepsinin desteklenmesi önemlidir."

**Context**: Memry is a shipped, end-to-end encrypted, offline-first desktop knowledge app with real users and live vaults. This feature brings the same product to mobile as a second shell over the same vault and the same sync service. Scope follows the agreed decision record `docs/ideas/2026-08-22-mobile-expo-plan.md` and the project constitution (v1.0.0): **vault parity, not desktop-tool parity** — every kind of content a user owns is reachable on mobile; desktop-only tooling is explicitly excluded and labeled.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Open Your Vault on Your Phone (Priority: P1)

An existing Memry user installs the mobile app, signs in to their account, unlocks their vault with the same password or recovery phrase they use today, and within moments is browsing the same notes, tasks, journals, projects, and other content they see on desktop — without the service ever being able to read their content.

**Why this priority**: This is the foundation of every other story and the single biggest promise of the product: _your_ vault, still private, now in your pocket. If an existing vault does not open with existing credentials, the product has failed totally; nothing else matters until this works.

**Independent Test**: Take a real, desktop-created vault; on a phone that has never seen it, sign in, unlock with the vault password (and separately with the recovery phrase), and verify recent content is browsable and readable. Delivers standalone value as a read-only companion even before editing exists.

**Acceptance Scenarios**:

1. **Given** an existing account with a desktop-created vault, **When** the user signs in on mobile and enters their vault password, **Then** the vault unlocks and its content becomes readable on the device.
2. **Given** a user who only has their recovery phrase, **When** they choose the recovery-phrase path during onboarding, **Then** the vault unlocks equivalently.
3. **Given** a first sync in progress on a large vault, **When** the user starts browsing, **Then** recently modified content is available first, older content loads on demand, and determinate progress is shown — the app is usable before the full sync completes.
4. **Given** an unlocked vault, **When** content is inspected anywhere outside the user's devices, **Then** it is unreadable (end-to-end encryption is preserved on the mobile path).
5. **Given** a wrong password, **When** unlock is attempted, **Then** a clear error is shown and nothing is corrupted or partially unlocked.

---

### User Story 2 - Edit Notes Anywhere, Offline First (Priority: P1)

The user opens any note and edits it with the full richness they know from desktop — headings, lists, checkboxes, quotes, code, tables, images and attachments, wiki-links, tags, and properties — on the subway with no signal, and their edits merge cleanly with whatever happened on desktop in the meantime.

**Why this priority**: Notes are the core of the product, and mobile without editing is a viewer, not a shell of the same product. Offline durability and cross-device convergence are what make it trustworthy.

**Independent Test**: With sync suspended, edit an existing note and create a new one on mobile; force-quit and relaunch the app; restore connectivity; verify all edits appear on desktop intact, and a concurrent desktop edit to the same note merges without either side losing content.

**Acceptance Scenarios**:

1. **Given** a note created on desktop with every supported block type, **When** it is opened on mobile, **Then** all content renders faithfully and remains editable without corruption.
2. **Given** airplane mode, **When** the user creates and edits notes, **Then** all changes persist locally, survive force-quit and device restart, and sync completely once connectivity returns.
3. **Given** the same note edited concurrently on desktop and mobile, **When** both devices sync, **Then** both sets of changes converge and neither side's edits are lost.
4. **Given** a note containing wiki-links, **When** the user taps a link, **Then** the linked note (or heading/alias target) opens; typing a new wiki-link offers autocomplete against existing notes.
5. **Given** a note with properties and tags, **When** the user edits property values or tags on mobile, **Then** the changes are reflected identically on desktop, preserving type and letter-case semantics.
6. **Given** an available note template, **When** the user creates a note from it, **Then** the new note matches the template's structure.

---

### User Story 3 - Manage Tasks and Get Reminded (Priority: P2)

The user captures, schedules, and completes tasks on mobile — with due dates, recurrence, priorities, and project assignment — and the phone reminds them at the right time even when the app is closed.

**Why this priority**: Tasks are the highest-frequency, shortest-interaction feature; the phone is where task capture and reminders naturally live. Depends on the vault and sync foundation of Story 1–2.

**Independent Test**: Create a recurring task with a reminder on mobile; complete an instance; verify recurrence advances, desktop reflects it, and a scheduled reminder fires as a notification on time with the app closed.

**Acceptance Scenarios**:

1. **Given** an unlocked vault, **When** the user creates a task with title, due date, priority, project, and recurrence, **Then** it appears in the relevant task views on both shells with identical semantics.
2. **Given** a task with a reminder, **When** the reminder time arrives while the app is closed or the device is offline, **Then** a notification fires on time and tapping it opens the task.
3. **Given** a task that also exists as a checkbox inside a note, **When** it is completed in either place on mobile, **Then** the note content and the task views stay consistent.
4. **Given** concurrent field edits to the same task on two devices (e.g., date changed on desktop, priority on mobile), **Then** both field changes survive after sync.

---

### User Story 4 - Daily Journal on the Go (Priority: P2)

The user opens today's journal entry in one tap, writes with the full editor, and can browse or backfill any past date — one entry per day, same as desktop.

**Why this priority**: Journaling is a daily habit that mobile makes far more likely to stick; it reuses the note-editing foundation of Story 2.

**Independent Test**: Open today's entry from a fresh app start in one tap, write content, then open a past date and verify the entry created on desktop for that date appears and is editable.

**Acceptance Scenarios**:

1. **Given** the app is opened, **When** the user chooses Journal, **Then** today's entry opens (created if absent) with the full rich editor.
2. **Given** an existing entry for a past date, **When** the user navigates to that date, **Then** exactly that entry opens — never a duplicate for the same day.
3. **Given** journal edits on mobile, **When** desktop syncs, **Then** the same day shows the merged entry.

---

### User Story 5 - Quick Capture to Inbox and Triage (Priority: P2)

Anything on the user's mind goes into the inbox in a couple of taps; later, they triage each item into a note, a task, or the trash.

**Why this priority**: Fast capture is the reason to reach for the phone at all; the inbox is the buffer that keeps the rest of the vault organized.

**Independent Test**: From app start, capture an inbox item within two interactions; then convert one item to a task, one to a note, discard one, and verify the results on desktop.

**Acceptance Scenarios**:

1. **Given** the app is open anywhere, **When** the user invokes quick capture and types a line, **Then** an inbox item is saved in at most two interactions from app start, including fully offline.
2. **Given** inbox items exist, **When** the user triages one into a note or task, **Then** the resulting item carries the captured content and the inbox item is cleared.
3. **Given** unprocessed inbox items, **When** the user looks at inbox entry points, **Then** a count of pending items is visible.

---

### User Story 6 - Manage Your Calendar (Priority: P3)

The user sees their events, dated tasks, and journal days on a calendar, and creates, edits, or deletes events directly on mobile.

**Why this priority**: The calendar ties tasks, journals, and events into one time view; it builds on Stories 3–4 rather than standing alone.

**Independent Test**: Create a timed event and an all-day event on mobile; verify both render on desktop's calendar; move one event to another day on mobile and verify the change syncs.

**Acceptance Scenarios**:

1. **Given** events and dated tasks exist, **When** the user opens the calendar, **Then** month and day/agenda views show events, tasks, and journal-entry days for the visible range.
2. **Given** the calendar is open, **When** the user creates or edits an event (title, date, time or all-day, duration), **Then** the event syncs and renders identically on desktop.
3. **Given** a dated item on the calendar, **When** the user taps it, **Then** the underlying task, journal entry, or event opens.

---

### User Story 7 - Home at a Glance (Priority: P3)

Opening the app lands the user on a calm home screen: today's tasks, recent notes, a journal shortcut, inbox count — a mobile-adapted equivalent of their desktop home.

**Why this priority**: Home is the daily entry point that makes the rest discoverable; it aggregates Stories 2–6 rather than adding new data.

**Independent Test**: With a vault containing due tasks, recent notes, and pending inbox items, open the app and verify each home section shows the correct items and navigates to the right destination.

**Acceptance Scenarios**:

1. **Given** an unlocked vault, **When** the app opens, **Then** a home screen summarizes today (due/overdue tasks, recent notes, journal shortcut, inbox count) without waiting on the network.
2. **Given** the user's home configuration from desktop, **When** home renders on mobile, **Then** sections honor that configuration wherever the equivalent concept exists on mobile; desktop-only widgets are omitted without error.
3. **Given** any home section item, **When** tapped, **Then** the corresponding item or view opens.

---

### User Story 8 - View Canvases (Read-Only) (Priority: P3)

The user browses their canvases and opens any of them in a faithful, pan-and-zoom read-only view, clearly labeled as view-only on mobile.

**Why this priority**: Canvases must be reachable for vault parity, but editing is explicitly out of v1 scope; a trustworthy viewer delivers the core value without risking canvas data.

**Independent Test**: Open a desktop-created canvas with shapes, text, and connectors on mobile; verify visual fidelity, pan/zoom, an explicit read-only indicator, and that the canvas remains byte-identical after viewing.

**Acceptance Scenarios**:

1. **Given** canvases exist in the vault, **When** the user opens one on mobile, **Then** it renders faithfully with pan and zoom.
2. **Given** an open canvas, **When** the user attempts to modify it, **Then** the app states plainly that canvases are view-only on mobile — nothing fails silently and no modification is written.
3. **Given** a canvas viewed on mobile, **When** it is next opened on desktop, **Then** it is unchanged.

---

### User Story 9 - Find Anything Fast (Priority: P3)

The user searches their whole vault — notes, journals, tasks, inbox — by text and gets ranked results instantly, including fully offline.

**Why this priority**: Search is how a large vault stays usable on a small screen; it spans every content type from earlier stories.

**Independent Test**: In airplane mode, search for a phrase known to exist in a synced note, a task title, and a journal entry; verify all three are found and open correctly.

**Acceptance Scenarios**:

1. **Given** synced content, **When** the user searches a phrase, **Then** matching notes, journal entries, tasks, and inbox items are returned ranked, and each result opens the right item.
2. **Given** airplane mode, **When** the user searches, **Then** results over already-synced content are returned normally.

---

### User Story 10 - Subscribe on Your Phone (Priority: P4)

A user can purchase a Memry subscription inside the mobile app; entitlement from either the web or the mobile store unlocks sync, and holding both at once is detected and surfaced honestly.

**Why this priority**: Required for a store-compliant launch and for mobile-first customers, but it gates monetization, not core product value.

**Independent Test**: In the store's test environment, purchase a subscription and verify sync-gated features activate; then simulate an account that also holds an active web subscription and verify the app surfaces the double-subscription state with guidance.

**Acceptance Scenarios**:

1. **Given** an account without an active subscription, **When** the user completes an in-app purchase, **Then** sync entitlement activates on the account without manual steps.
2. **Given** an active subscription purchased on either platform, **When** the user uses either shell, **Then** entitled features work; where both exist, the later expiry governs.
3. **Given** active subscriptions on both platforms, **When** the user opens the app, **Then** the double-subscription state is stated plainly with guidance on how to resolve it — it is never silently absorbed.

---

### Edge Cases

- App is killed by the system mid-edit or mid-sync: no queued change may be lost; on relaunch, pending changes still sync.
- First sync on a very large vault (tens of thousands of items) over a slow connection: app stays usable, shows determinate progress, and never blocks open on the network.
- Same note deleted on one device while edited on another: the outcome is deterministic, consistent across shells, and never a partial/corrupt note.
- Reminder fires for a task that was completed or deleted on another device moments earlier: stale notification handling opens a sensible state, never a crash or a ghost item.
- Attachment referenced by a note has not been downloaded yet (lazy/Wi-Fi-only policy): a clear placeholder with an explicit fetch action; a late-arriving attachment becomes visible without recreating the note.
- Device clock is wrong: journal "today", task due logic, and reminders behave predictably; sync convergence is not corrupted by clock skew.
- Service requires a newer client version (or the platform kill switch is active): the app drops to read-only with a plain explanation and an update path; reads keep working; queued writes are preserved, not discarded.
- Storage pressure on the device: the app's local data survives OS cache eviction; unsynced writes are never stored in evictable storage.
- Subscription lapses while offline edits are queued: the user's data remains readable and exportable; queued changes are handled per entitlement policy with a clear message, never silently dropped.
- Vault content written by a newer desktop version contains fields mobile does not know: unknown data is preserved round-trip, never stripped.
- Account deletion is requested from mobile: the flow completes in-app and the outcome matches the existing service-side deletion behavior.

## Requirements _(mandatory)_

### Functional Requirements

**Vault access & privacy**

- **FR-001**: Users MUST be able to sign in to their existing account and unlock an existing vault on mobile using either their vault password or their recovery phrase.
- **FR-002**: All vault content MUST remain end-to-end encrypted on the mobile path; the service MUST never be able to read note bodies, titles, or any user content originating from or synced to mobile.
- **FR-003**: Vault secrets MUST be stored only in device-protected secure storage on that device, available only while the device is unlocked, and MUST never appear in logs, telemetry, or backups readable off-device.
- **FR-004**: Users with more than one vault MUST be able to choose which vault to open and switch between them.

**Sync & offline**

- **FR-005**: Every user-editable capability MUST work fully offline; changes made offline MUST be durably queued, survive force-quit and device restart, and sync completely on reconnect.
- **FR-006**: All twelve synced content types (notes, journals, tasks, projects, canvases, bookmarks, inbox items, attachments, templates, saved filters, reminders, settings) MUST sync to mobile; user-editable types MUST sync from mobile as well.
- **FR-007**: Concurrent edits to the same item on different devices MUST converge without losing either side's changes — at content level for long-form bodies, at field level for structured items.
- **FR-008**: First sync on a new device MUST prioritize recent content, fetch older bodies on demand, show determinate progress, and never block app usability on completion of the full sync.
- **FR-009**: Attachment content MUST download lazily, defaulting to unmetered connections for large transfers, with an explicit per-item override.
- **FR-010**: When the service requires a newer client version, or a platform-wide safety switch is active, the mobile app MUST enter an explicit read-only mode: writes blocked with a plain explanation and update path, reads uninterrupted, queued local changes preserved.
- **FR-011**: Changes originating from mobile MUST be attributable service-side (platform and version) so an incident can be traced and rolled back.

**Notes**

- **FR-012**: Users MUST be able to create, edit, rename, move, and delete notes, and browse and manage the same folder hierarchy as desktop.
- **FR-013**: The mobile editor MUST render and preserve every block type a desktop note can contain (headings, paragraphs, lists, checkboxes, quotes, code, tables, images, embedded attachments); no mobile interaction may corrupt or drop content it cannot edit.
- **FR-014**: Wiki-links MUST render with their display alias, navigate to their target (including heading targets), and offer autocomplete when authoring.
- **FR-015**: Users MUST be able to view, add, and remove tags with letter-case behavior identical to desktop.
- **FR-016**: Users MUST be able to view and edit note properties; property definitions and value types MUST behave identically to desktop.
- **FR-017**: Users MUST be able to create a note from an existing template.
- **FR-018**: Editing MUST support undo and redo within an editing session.

**Tasks, projects & reminders**

- **FR-019**: Users MUST be able to create, edit, complete, and delete tasks with due/scheduled dates, priority, recurrence, and project assignment.
- **FR-020**: Task views MUST include at least today, upcoming, by-project, and completed, with the same membership semantics as desktop.
- **FR-021**: A task represented as a checkbox inside a note and the same task in task views MUST stay consistent when either is changed on mobile.
- **FR-022**: Users MUST be able to view projects, their associated tasks and notes, and create and edit projects.
- **FR-023**: Reminders MUST fire as device notifications at the scheduled time using already-synced data — including with the app closed or offline — and tapping one MUST open the item.

**Journal**

- **FR-024**: The journal MUST maintain exactly one entry per calendar day; today's entry MUST be reachable in one interaction from app open, and any date MUST be reachable by navigation.
- **FR-025**: Journal entries MUST support the same editing capabilities as notes.

**Calendar**

- **FR-026**: The calendar MUST provide month and day/agenda views showing events, dated tasks, and journal-entry days.
- **FR-027**: Users MUST be able to create, edit, and delete calendar events (title, date, time or all-day, duration) with identical semantics to desktop.
- **FR-028**: Items shown on the calendar MUST open their underlying task, event, or journal entry when selected.

**Inbox**

- **FR-029**: Users MUST be able to capture an inbox item in at most two interactions from app start, including offline.
- **FR-030**: Users MUST be able to triage inbox items — convert to a note or task (carrying the captured content) or discard — and see a pending-item count.

**Home**

- **FR-031**: The app MUST provide a home screen summarizing today (due and overdue tasks, recent notes, journal shortcut, inbox count) that renders from local data without waiting on the network.
- **FR-032**: Home MUST honor the user's synced home configuration wherever the equivalent concept exists on mobile; desktop-only widgets MUST be omitted gracefully, never rendered broken.

**Canvas**

- **FR-033**: Users MUST be able to browse canvases and open any canvas in a faithful read-only view with pan and zoom.
- **FR-034**: The canvas view MUST state plainly that editing is not available on mobile; viewing MUST never modify canvas data.

**Bookmarks, filters, settings**

- **FR-035**: Users MUST be able to view, open, create, and delete bookmarks.
- **FR-036**: Users MUST be able to apply their saved filters, producing the same results as desktop for the same data.
- **FR-037**: Synced user preferences MUST apply on mobile wherever the preference's concept exists on mobile.

**Search**

- **FR-038**: Full-text search MUST cover notes, journals, tasks, and inbox items over all locally synced content, return ranked results, and work offline.

**Billing & entitlement**

- **FR-039**: Users MUST be able to purchase a subscription inside the app through the platform's store; a completed purchase MUST activate sync entitlement on the account without manual steps.
- **FR-040**: An active subscription from either purchase platform MUST entitle the account; when both exist, the later expiry MUST govern.
- **FR-041**: The app MUST detect and plainly surface an account holding active subscriptions on both platforms, with guidance to resolve it.

**Trust, compliance & consistency**

- **FR-042**: Users MUST be able to delete their account from within the app.
- **FR-043**: The app's privacy disclosures MUST accurately reflect actual data collection (telemetry exists and is not identity-linked; "collects nothing" is a false statement and MUST NOT be made).
- **FR-044**: The mobile app MUST meet WCAG AA contrast, provide screen-reader labels for all interactive elements, honor reduced-motion preferences, and lay out correctly in RTL languages.
- **FR-045**: Shared concepts MUST use the same terminology, semantics, and state transitions as desktop; degraded states (offline, syncing, unentitled, locked, read-only) MUST be explicit and use the same vocabulary on both shells.
- **FR-046**: Any capability that is absent or read-only on mobile MUST say so in the interface rather than fail silently.

### Key Entities

- **Vault**: A user's end-to-end encrypted store of all content; unlockable by password or recovery phrase; one account may hold several; the shared contract between desktop and mobile.
- **Note**: Long-form rich content in a folder hierarchy; carries tags, properties, wiki-links, and attachments.
- **Journal entry**: A note-like body bound to exactly one calendar day.
- **Task**: A completable item with dates, priority, recurrence, and optional project; may also live as a checkbox inside a note.
- **Project**: A grouping of tasks and notes with its own overview.
- **Calendar event**: A timed or all-day occurrence on the calendar.
- **Inbox item**: A quickly captured fragment awaiting triage into a note or task.
- **Canvas**: A spatial diagram of shapes, text, and connectors; view-only on mobile.
- **Bookmark**: A saved link item.
- **Template**: A reusable note structure applied at creation.
- **Saved filter**: A stored query producing a filtered view of items.
- **Attachment**: A binary file referenced by content; fetched lazily on mobile.
- **Reminder**: A scheduled prompt bound to an item, delivered as a device notification.
- **Settings**: Synced user preferences applied per-shell where applicable.
- **Device & entitlement**: A registered device participating in sync; entitlement is the account's active subscription state, sourced from either platform.

### Out of Scope (v1)

Scope divergence is explicit per the constitution; each exclusion is a recorded decision with a reason, and each affected surface says so in the UI rather than failing silently.

| Capability                                 | v1 status                                                       | Reason                                                                                                                                                                                                                                       |
| ------------------------------------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent Chat                                 | Absent                                                          | Depends on desktop-only local tooling that the mobile platform cannot host                                                                                                                                                                   |
| Importers (from other apps)                | Absent                                                          | Require reading other apps' local data, which the mobile sandbox forbids                                                                                                                                                                     |
| Semantic / AI search                       | Absent (full-text search stays)                                 | On-device semantic engine unavailable on mobile in v1                                                                                                                                                                                        |
| Canvas editing                             | Read-only view ships                                            | Desktop canvas editing technology is not portable in v1; a bad port risks canvas data                                                                                                                                                        |
| System share-sheet capture from other apps | Deferred to v2                                                  | In-app quick capture covers v1; external capture into an encrypted vault is separate scope                                                                                                                                                   |
| Instant push-triggered sync                | Deferred (periodic background + foreground sync ship)           | No server push infrastructure exists today                                                                                                                                                                                                   |
| Biometric app lock                         | Screen ships, off by default                                    | Reversed 2026-08-28 with the Paper `09 · Device unlock` board. It is an app-level gate, not a change to key storage, so no install migrates; it stays off until the Settings toggle ships, which keeps the original lockout concern answered |
| Android at launch                          | Follows iOS from the same product definition (~4–8 weeks after) | Solo development; serialized QA                                                                                                                                                                                                              |

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 100% of existing production-format vaults unlock on mobile with the user's existing password and, separately, recovery phrase — verified against real desktop-created vaults before any external testing.
- **SC-002**: A change made on one device is visible on another within 5 seconds on a healthy network, in both directions.
- **SC-003**: Typing in a 50 KB note shows no perceptible lag: under 50 ms from keystroke to visible character on a mid-tier phone.
- **SC-004**: On a new device with a 10,000-item vault on Wi-Fi, the user can browse and open recent content within 2 minutes of unlocking; app open is never blocked on the network thereafter.
- **SC-005**: Every one of the twelve synced content types is reachable on mobile; a user auditing their vault finds 100% of their items represented.
- **SC-006**: Zero data loss across the offline matrix: offline edits followed by force-quit, restart, and reconnect sync completely in 100% of test runs; a mobile-viewed canvas is byte-identical afterward.
- **SC-007**: Two-shell parallel use for 7 days by beta users on their real vaults produces zero divergence reports (content identical on both shells) and zero corrupted items.
- **SC-008**: An inbox capture takes at most 2 interactions from app start; a reminder notification fires within 1 minute of its scheduled time in 99% of cases.
- **SC-009**: A store-test subscription purchase activates sync entitlement within 1 minute; an account holding subscriptions on both platforms sees the double-subscription notice on next app open in 100% of cases.
- **SC-010**: The app is approved for distribution on the platform store, including accurate privacy declarations and in-app account deletion.
- **SC-011**: Accessibility audit passes: WCAG AA contrast, screen-reader labels on all interactive elements, reduced-motion honored, RTL layout correct.

## Assumptions

- The agreed decision record (`docs/ideas/2026-08-22-mobile-expo-plan.md`) and constitution v1.0.0 are authoritative for scope: the user's "all main features from day one" is interpreted as **vault parity** — all seven named areas (notes, tasks, journal, calendar, inbox, home, canvas) ship in v1 with their sub-features, with the explicit exclusions recorded in Out of Scope (notably: canvas is view-only).
- The existing account system, sync service, entitlement model, and encryption scheme are reused unchanged; mobile joins them as a new device class rather than introducing new service concepts.
- iOS is the launch platform; Android follows from the same product definition. All requirements in this spec apply to both.
- "Home" on mobile is a mobile-adapted equivalent of the desktop home board, honoring synced configuration where concepts overlap — not a pixel port of desktop chrome.
- Existing desktop users are the primary v1 audience; mobile-first onboarding (creating a brand-new vault from the phone) is included via the existing account + vault creation flows, but the launch bet is companion use.
- Solo development with a phased release train (spike → shared-core extraction → read-only shell → editing → remaining types → billing → store submission) governs sequencing; if schedule slips, canvas viewing and reminders are the first recorded cuts.
- Production safety mechanisms (client version gate, per-platform read-only switch, attributable writes) are in place before any external tester writes to a real vault.
