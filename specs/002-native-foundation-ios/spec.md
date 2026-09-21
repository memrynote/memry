# Feature Specification: Memry Native — Foundation + iOS Shell

**Feature Branch**: `002-native-foundation-ios`

**Created**: 2026-09-12

**Status**: Draft

**Input**: User description: "Native iOS app over a shared Rust core: foundation + iOS shell. Foundation = written sync/crypto protocol specification derived from the existing TypeScript implementation, composite conformance vectors (signed record envelope, packed CRDT update, MPAK pack, field-merge cases) generated and verified by the desktop suite, and a Rust crate (crates/memry-core) implementing auth, crypto, sync engine, CRDT via yrs, SQLite storage, and domain logic for notes/folders/tags/properties/templates/journal/tasks/reminders/search, proven headless as a CLI round trip against staging with a real desktop. iOS shell = apps/ios SwiftUI (iOS 26+) over UniFFI bindings: sign in (OTP, Google), vault unlock (recovery phrase, QR device link), notes browsing and editing (WebView-hosted BlockNote via the existing webview-bridge contract, Rust owns the Y.Doc), folders, tags, search, journal, tasks, reminders, settings sync, read-only kill-switch mode, TestFlight-ready. apps/mobile (React Native) is frozen and superseded. Android is a later feature over the same core."

**Context**: Memry is a shipped, end-to-end encrypted, offline-first desktop knowledge app with real users and live vaults. This feature does two things at once: it writes the vault protocol down as a specification with committed conformance vectors so a second implementation can be proven against it, and it ships the first native phone shell over that second implementation. Scope follows the decision record `docs/ideas/2026-09-12-native-ios-rust-core-plan.md` and the project constitution (v2.2.0). `specs/001-mobile-app` is superseded by this spec and `apps/mobile` is frozen: it accepts no new commits except deletions and remains in-tree only as reference material. The foundation half is not preparation for the product, it is the part of the product that decides whether the vault opens at all.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - The Protocol Is Written Down And A Second Implementation Can Be Proven Against It (Priority: P1)

The maintainer writes the vault's protocol down as a document, independent of the code that currently implements it, and commits a set of conformance vectors that any implementation can be measured against. Today the protocol lives only as the behaviour of one implementation: the wire formats are byte-exact but discoverable only by reading source, and the field-merge rules include tie-break heuristics that are written nowhere. After this story, the protocol is a specification and the vectors are the test of whether something speaks it.

**Why this priority**: the second implementation is being built from this document. Every ambiguity left in it becomes a silent divergence on a real user's vault, discovered weeks later as missing content. Writing it down first is also the only way to know the existing behaviour is understood rather than assumed.

**Independent Test**: hand the specification and the vector set to a reader who has no access to the existing implementation's source, and confirm they can state, for any vector, exactly what bytes go in and what bytes must come out and why. Run the desktop test suite and confirm it verifies every committed vector. Delivers standalone value even if no phone is ever built: the protocol stops being tribal knowledge.

**Acceptance Scenarios**:

1. **Given** the current implementation's behaviour, **When** the specification is written, **Then** it covers authentication and token lifecycle, the signed record envelope and its canonical signing bytes, the collaborative-document update envelope, sync routes, headers and item-type negotiation, the pack container, the field-merge rules including every tie-break, and the markdown body grammar and frontmatter serialization.
2. **Given** an item type that exists in the vault today, **When** the specification is consulted, **Then** it states unambiguously whether that type's body travels as a collaborative document or as a signed record, with journal entries named explicitly rather than left to runtime inference.
3. **Given** the committed vector set, **When** the desktop test suite runs, **Then** every vector is verified against the existing implementation and the suite fails if any vector and the implementation disagree.
4. **Given** a reader with the specification and the vectors but no access to the existing source, **When** they implement a client, **Then** nothing required to pass the vectors is missing from the document.
5. **Given** two implementations and the same pair of conflicting field values, **When** each applies the specified merge order, **Then** both pick the same winner and both report the same set of conflicted fields.
6. **Given** a later change to the protocol, **When** it lands, **Then** the specification and the vectors are updated in the same change, and the suite fails if they are not.

---

### User Story 2 - The Shared Core Proves A Full Round Trip Without Any UI (Priority: P1)

The maintainer runs the shared core headlessly, with no phone and no screens, against the staging service with a real desktop on the other side. It signs in, registers as a device, unlocks a vault a real desktop created, pulls and decrypts it, edits a note body and a task, pushes, and the edits show up on the desktop. A desktop edit comes back the other way. Concurrent edits on both sides converge. The service's read-only switch is obeyed.

**Why this priority**: a vault that does not open, or opens and then corrupts, is a total product failure, and a phone screen in front of it only makes the failure harder to see. This gate is deliberately placed before any phone UI exists so that a failure here is cheap and unambiguous.

**Independent Test**: from a terminal, with no shell application installed, run the round trip against staging with a real desktop signed into the same account, and observe each direction land. Delivers standalone value as the proof that the second implementation is real.

**Acceptance Scenarios**:

1. **Given** a staging account and a vault created by a real desktop, **When** the headless client signs in and registers as a device, **Then** it unlocks that vault and decrypts its content without the desktop being modified in any way.
2. **Given** an unlocked vault in the headless client, **When** it edits a note body and a task and pushes, **Then** both edits appear on the real desktop with correct content and without validation errors or skipped items.
3. **Given** a note pulled and then written back without any edit, **When** the desktop next reads it, **Then** the body is byte-identical to what the desktop wrote.
4. **Given** an edit made on the real desktop, **When** the headless client pulls, **Then** that edit appears in the headless client.
5. **Given** the same note and the same task edited concurrently in both places, **When** both sides sync, **Then** the results converge and neither side's changes are lost.
6. **Given** the service's per-platform read-only switch is active, **When** the headless client attempts a write, **Then** the write is refused locally with a stated reason, the queued change is preserved, and reads continue.
7. **Given** this round trip is not green, **When** shell work is proposed, **Then** it does not start.

---

### User Story 3 - Open Your Vault On Your iPhone (Priority: P1)

An existing Memry user installs the app, signs in with a code sent to their email or with their Google account, and unlocks a vault either by typing their recovery phrase or by scanning a code shown on a desktop they are already signed into. If the account holds more than one vault, they pick which one to open. Within moments they are browsing the same notes and folders they see on desktop, and the service still cannot read any of it.

**Why this priority**: this is the foundation of every other phone story and the biggest promise of the product: your vault, still private, now in your pocket. If an existing vault does not open, nothing else matters.

**Independent Test**: take a real, desktop-created vault; on a phone that has never seen it, sign in, unlock by recovery phrase, and separately unlock a second phone by scanning the desktop's code; verify recent content is browsable and readable. Repeat on an account holding two vaults and verify both are listed and either can be opened. Delivers standalone value as a read-only companion before editing exists.

**Acceptance Scenarios**:

1. **Given** an existing account, **When** the user signs in with a one-time code sent to their email, **Then** they reach the unlock step.
2. **Given** an existing account created with Google, **When** the user signs in with Google, **Then** they reach the unlock step.
3. **Given** a user who chooses Apple sign-in with a private relay address, **When** the address does not match an existing account, **Then** the app offers to link an existing account by verifying its real email with a one-time code, and only then reaches the unlock step; name and email delivered on the first authorization are persisted.
4. **Given** an account holding more than one vault, **When** the user reaches the unlock step, **Then** every vault on the account is listed and the user chooses which to open; the choice can be changed later from settings.
5. **Given** a user who has the recovery phrase for the chosen vault, **When** they enter it, **Then** that vault unlocks and its content becomes readable on the device.
6. **Given** a desktop that is already signed in and unlocked, **When** the user scans the code it displays and confirms the short verification code shown on both screens, **Then** the phone is linked as a new device and the vault unlocks without the recovery phrase ever being typed on the phone.
7. **Given** a first sync in progress on a large vault, **When** the user starts browsing, **Then** recently modified content is available first, older content loads on demand, determinate progress is shown, and the app is usable before the full sync completes.
8. **Given** an unlocked vault, **When** content is inspected anywhere outside the user's devices, **Then** it is unreadable.
9. **Given** an incorrect recovery phrase, **When** unlock is attempted, **Then** a clear error is shown and nothing is corrupted or partially unlocked.
10. **Given** an unlocked vault, **When** the user signs out, **Then** the vault locks and the device holds no readable vault content and no key material afterwards.

---

### User Story 4 - Edit Notes Anywhere, Offline First (Priority: P1)

The user opens any note and edits it with the full richness they know from desktop: headings, lists, checkboxes, quotes, code, tables, inline images, wiki-links, tags, and properties. They do it on the subway with no signal, and their edits merge cleanly with whatever happened on desktop in the meantime.

**Why this priority**: notes are the core of the product, and a phone without editing is a viewer, not a shell of the same product. Offline durability and cross-device convergence are what make it trustworthy.

**Independent Test**: with sync suspended, edit an existing note and create a new one on the phone; force-quit and relaunch; restore connectivity; verify all edits appear on desktop intact, and a concurrent desktop edit to the same note merges without either side losing content.

**Acceptance Scenarios**:

1. **Given** a note created on desktop containing every block, inline, and style type enumerated in the requirements, **When** it is opened on the phone, **Then** every type renders, every text-bearing type is editable, and closing the note without editing leaves its stored body byte-identical to what the desktop wrote.
2. **Given** an edit to one paragraph of a large note, **When** the note is saved and read on desktop, **Then** only that region's serialization has changed and the rest of the body is byte-identical.
3. **Given** a note whose content includes a node type the loaded editor bundle cannot build, **When** the user opens it, **Then** the app refuses to open the body for editing, says so plainly, and still lets the user read the note. Nothing is deleted.
4. **Given** airplane mode, **When** the user creates and edits notes, **Then** all changes persist locally, survive force-quit and device restart, and sync completely once connectivity returns.
5. **Given** the same note edited concurrently on desktop and phone, **When** both devices sync, **Then** both sets of changes converge and neither side's edits are lost.
6. **Given** a note containing wiki-links, **When** the user taps a link, **Then** the linked note or heading target opens; typing a new wiki-link offers autocomplete against existing notes.
7. **Given** a note with properties and tags, **When** the user edits property values or tags on the phone, **Then** the changes are reflected identically on desktop, preserving type and letter-case semantics.
8. **Given** a note referencing an inline image whose bytes have not been downloaded, **When** the note is opened, **Then** a placeholder is shown and the image appears when the bytes arrive, without the note being recreated.
9. **Given** an available note template, **When** the user creates a note from it, **Then** the new note matches the template's structure.
10. **Given** an editing session, **When** the user undoes and redoes, **Then** the document returns to the expected state.

---

### User Story 5 - Organise And Find: Folders, Tags, Search (Priority: P2)

The user reshapes their folder tree, manages their tags, and searches the whole vault by text, getting ranked results instantly even with no signal.

**Why this priority**: organisation and search are how a large vault stays usable on a small screen. They build on the note foundation of Stories 3 and 4 rather than standing alone.

**Independent Test**: create, rename, move, and delete folders on the phone and verify each change on desktop; then, in airplane mode, search for a phrase known to exist in a synced note, a task title, and a journal entry, and verify all three are found, ranked in the same order desktop produces, and open correctly.

**Acceptance Scenarios**:

1. **Given** an unlocked vault, **When** the user creates, renames, moves, or deletes a folder, **Then** the change syncs and the resulting hierarchy matches desktop exactly.
2. **Given** tags in the vault, **When** the user browses tags, **Then** every tag is listed with its tagged items, using the same letter-case behaviour as desktop.
3. **Given** synced content, **When** the user searches a phrase, **Then** matching notes, journal entries, and tasks are returned in the same order desktop returns for the same query and corpus, and each result opens the right item.
4. **Given** airplane mode, **When** the user searches, **Then** results over already-synced content are returned normally.

---

### User Story 6 - Daily Journal On The Go (Priority: P2)

The user opens today's journal entry in one tap, writes with the full editor, and can browse or backfill any past date. One entry per day, same as desktop.

**Why this priority**: journaling is a daily habit that a phone makes far more likely to stick, and it reuses the editing foundation of Story 4 rather than adding new machinery.

**Independent Test**: open today's entry from a fresh app start in one interaction, write content, then open a past date and verify the entry created on desktop for that date appears and is editable.

**Acceptance Scenarios**:

1. **Given** the app is opened, **When** the user chooses Journal, **Then** today's entry opens, created if absent, with the full editor.
2. **Given** an existing entry for a past date, **When** the user navigates to that date, **Then** exactly that entry opens and never a duplicate for the same day.
3. **Given** journal edits on the phone, **When** the desktop syncs, **Then** the same day shows the merged entry.

---

### User Story 7 - Manage Tasks And Get Reminded (Priority: P2)

The user captures, schedules, and completes tasks on the phone, with due dates, recurrence, priorities, and project assignment, and the phone reminds them at the right time even when the app is closed.

**Why this priority**: tasks are the highest-frequency, shortest-interaction feature, and the phone is where capture and reminders naturally live. Depends on the vault and sync foundation.

**Independent Test**: create a recurring task with a reminder on the phone; complete an instance; verify recurrence advances, desktop reflects it, and the scheduled reminder fires as a notification on time with the app closed.

**Acceptance Scenarios**:

1. **Given** an unlocked vault, **When** the user creates a task with title, due date, priority, project, and recurrence, **Then** it appears in the relevant task views on both shells with identical semantics.
2. **Given** tasks exist, **When** the user opens task views, **Then** today, upcoming, by-project, and completed views show the same membership as desktop for the same data.
3. **Given** a task with a reminder, **When** the reminder time arrives while the app is closed or the device is offline, **Then** a notification fires on time and tapping it opens the task.
4. **Given** more reminders scheduled than the platform will hold at once, **When** the user opens reminder settings, **Then** the app states that only the nearest window is scheduled, and the window is refilled whenever the app runs in the foreground or gets a background refresh.
5. **Given** a task that also exists as a checkbox inside a note, **When** it is completed in either place on the phone, **Then** the note content and the task views stay consistent.
6. **Given** concurrent field edits to the same task on two devices, for example the date changed on desktop and the priority on the phone, **When** both sync, **Then** both field changes survive.

---

### User Story 8 - Settings And Safety Follow You (Priority: P3)

The user's synced preferences apply on the phone wherever the concept exists. When the service requires a newer client or the platform-wide safety switch is on, the app says so plainly, keeps reading, and holds queued writes rather than discarding them. The user can see which devices are on their account, remove one, and delete their account entirely.

**Why this priority**: these are the properties that make the app safe to hand to strangers. They are P3 only because they depend on everything above being in place.

**Independent Test**: flip the service-side read-only switch for this platform while the app holds queued offline writes; verify the app drops to read-only with a plain explanation, reading continues, and the queued writes are still there and sync once the switch is cleared. Separately, remove a device and delete an account from within the app.

**Acceptance Scenarios**:

1. **Given** preferences set on desktop, **When** the phone syncs, **Then** each preference whose concept exists on the phone applies, and preferences with no equivalent leave their surface in its default state with no error logged.
2. **Given** queued offline writes, **When** the platform-wide safety switch is turned on, **Then** the app enters read-only mode with a plain explanation and an update path, reads continue uninterrupted, and the queued writes are preserved.
3. **Given** the service requires a newer client version, **When** the app connects, **Then** the same read-only behaviour applies with an explanation naming the required update.
4. **Given** several devices on the account, **When** the user opens the device list, **Then** every device is listed and any of them can be removed.
5. **Given** this device's registration is revoked from another device, **When** this device next contacts the service, **Then** it enters a locked state, removes local vault content, and explains why.
6. **Given** an account with no active plan, **When** the user opens the app, **Then** already-synced content stays readable and the app states plainly that sync needs an active plan, without naming a price, linking out, or steering the user to any purchase mechanism.
7. **Given** a user who wants to leave, **When** they request account deletion in the app, **Then** the flow completes in-app and the outcome matches the existing service-side deletion behaviour.

---

### User Story 9 - Ready For Testers (Priority: P3)

The build goes out to external testers as a beta, with privacy declarations that are true, export-compliance answers that are correct, and a write path that has already been proven stoppable.

**Why this priority**: this is the release gate rather than a feature, and it depends on all of the above. It is written as a story because it has to be planned, not discovered during submission week.

**Independent Test**: submit a build for beta distribution and have it accepted; launch it on every supported device generation without a crash; exercise the read-only switch end to end against that exact build before any external tester writes to a real vault.

**Acceptance Scenarios**:

1. **Given** a candidate build, **When** it is submitted for beta distribution, **Then** it is accepted with privacy declarations that match what the app actually collects and with correct export-compliance answers.
2. **Given** the accepted build, **When** it is launched on each supported device generation, **Then** it opens without crashing.
3. **Given** writes originating from the phone, **When** they reach the service, **Then** they are attributable by platform and version so an incident can be traced and rolled back.
4. **Given** external testers are about to be invited, **When** the read-only switch has not been exercised against this build, **Then** the beta does not open.

---

### Edge Cases

- The loaded editor bundle and the schema the app ships against are out of step: the editor surface must refuse to initialise and the app must refuse to open any body for editing, because a node the bundle cannot build is deleted from the shared document and the deletion replicates to every device.
- The process dies between a batch of keystrokes reaching the core and the local commit: on relaunch, either the batch is present or it was never acknowledged, never a half-applied document.
- A device scans a linking code while it is already linked to the account: the link resolves to the existing device rather than creating a duplicate registration, and no key material is re-issued needlessly.
- The recovery phrase is entered with the right words in the wrong order: unlock fails with a clear message that distinguishes an ordering problem from an unknown word where that is possible, and nothing is partially unlocked.
- The user switches to another vault on the same account while writes for the previous vault are still queued: the queued writes are preserved, not discarded or misattributed, and they sync when that vault is next opened.
- A vault written by a newer desktop contains item types or fields this client does not know: unknown data is preserved round-trip and never stripped, and a page containing an item type the client did not subscribe to is neither failed nor treated as processed, and the cursor does not advance past it.
- A journal body could plausibly be routed as a collaborative document or as a record: the routing is decided by the protocol specification, not inferred at runtime by either implementation.
- The app is killed by the system mid-edit or mid-sync: no queued change may be lost, and on relaunch pending changes still sync.
- The phone is replaced and restored from a device backup: the secure store contents are absent, so the app starts locked, asks the user to unlock again, does not crash, and no vault plaintext or key material was present in the backup to begin with.
- The user removes the device passcode, weakening the secure store's protection class: the app detects that vault secrets are no longer retrievable under the required protection, locks, and asks the user to unlock again rather than failing silently.
- This device's registration is revoked while it is offline: on next contact the app locks and removes local vault content rather than continuing to serve content it is no longer entitled to hold.
- First sync on a very large vault over a slow connection: the app stays usable, shows determinate progress, and never blocks open on the network.
- The same note is deleted on one device while edited on another: the outcome is deterministic, consistent across shells, and never a partial or corrupt note.
- A reminder fires for a task that was completed or deleted on another device moments earlier: the notification opens a sensible state, never a crash or a ghost item.
- More reminders exist than the platform will schedule at once: the nearest window is scheduled and refilled, and the limitation is stated where the user can see it rather than discovered as a missing notification.
- The device clock is wrong: journal "today", task due logic, and reminders behave predictably, and sync convergence is not corrupted by clock skew.
- Storage pressure on the device: local data survives operating-system cache eviction, and unsynced writes are never held in evictable storage.
- The service requires a newer client version or the platform switch is active: the app drops to read-only with a plain explanation and an update path, reads keep working, and queued writes are preserved rather than discarded.
- An inline image referenced by a note has not been downloaded yet: a clear placeholder is shown, and a late-arriving image becomes visible without recreating the note.
- The user has no active plan: already-synced content stays readable and the app states that sync needs an active plan, with no price, no link, and no steering to any purchase mechanism.

## Requirements _(mandatory)_

### Functional Requirements

**Protocol specification and conformance**

- **FR-001**: A written protocol specification MUST exist, committed alongside this feature, covering authentication and token lifecycle, the signed record envelope and its canonical signing bytes, the collaborative-document update envelope, sync routes, headers and item-type negotiation, the pack container, the field-merge rules, and the markdown body grammar and frontmatter serialization including frontmatter key ordering and the preservation of body syntax the editor does not model.
- **FR-002**: The field-merge section MUST specify the complete winner-selection order for each field: the primary comparison by total clock ticks, the offline-origin tie-break, and the default winner when neither side dominates. It MUST separately specify the condition under which a field is reported as conflicted. Two implementations given the same inputs MUST produce the same winner and the same conflict set.
- **FR-003**: The specification MUST state, for every synced item type, whether its body travels as a collaborative document or as a signed record, with journal entries stated explicitly. No implementation may be required to infer this at runtime.
- **FR-004**: The specification MUST be sufficient on its own: an implementer with the document and the vectors, and no access to the existing implementation's source, MUST have everything needed to build a conforming client.
- **FR-005**: A conformance vector set MUST be committed covering cryptographic primitives, the vault-unlock flow, the signed record envelope, the packed collaborative-document update, the pack container, field-merge cases including tie-breaks and conflict reporting, and a markdown round-trip corpus that exercises the body grammar, frontmatter serialization, and the out-of-band encodings stored beside the body (inline colours, block markers, suggestion marks, link references, and the preserved source text).
- **FR-006**: Vectors MUST be generated from the existing implementation and verified by the existing desktop test suite, which MUST fail when a vector and the implementation disagree.
- **FR-007**: The second implementation MUST reproduce every committed vector byte for byte before any feature work depends on it.
- **FR-008**: Any later change to a covered format MUST update the specification and the affected vectors in the same change, enforced by the test suite.

**Shared core, proven headless**

- **FR-009**: A shared core MUST implement authentication and token lifecycle, cryptography, the sync engine and outbox, collaborative-document handling, local storage, and domain logic for notes, folders, tags, properties, templates, journal entries, tasks, projects (reading and assignment), reminders, settings, and search.
- **FR-010**: The shared core MUST be exercisable headlessly, with no user interface, so that every requirement in this group can be tested without a phone.
- **FR-011**: The headless client MUST sign in to the staging service, register as a device, and unlock a vault created by a real desktop, then pull and decrypt its content.
- **FR-012**: The headless client MUST edit a note body and a task and push them, and those edits MUST appear on a real desktop signed into the same account.
- **FR-013**: An edit made on that real desktop MUST appear in the headless client after a pull.
- **FR-014**: Concurrent edits to the same note body and to the same task, made in the headless client and on the desktop, MUST converge with no loss on either side.
- **FR-015**: The headless client MUST honour read-only mode: writes refused locally with a stated reason, queued changes preserved, reads unaffected.
- **FR-016**: The headless round trip in FR-011 through FR-015 MUST be green with recorded evidence before any shell user interface depends on the shared core.
- **FR-017**: Platform capabilities the core cannot provide itself MUST be reached through a fixed, enumerated set of eight seams: device secure storage, local file protection, notifications, background execution, network reachability, network transport (one request or one socket at a time, with no retry, auth, or protocol logic of its own), hosting of the note editor surface, and optical code capture through the camera for device linking. Adding a seam requires a written justification recorded in this spec. Justification for the network transport seam: the platform suspends raw sockets when the app leaves the foreground and applies its transport security, proxy, and background-transfer policies only to its own networking stack, so the shell supplies the socket and the core keeps every retry, backoff, token-refresh, and protocol decision. The ten adapters in the existing TypeScript sync client are not this list: under this architecture, storage, transport, and collaborative-document persistence move inside the shared core, and these eight seams are what remains for a shell.

**Vault access and privacy**

- **FR-018**: Users MUST be able to sign in to their existing account with a one-time code sent to their email address, with their Google account, and with their Apple account. The Apple option MUST accept a private relay address and MUST persist the name and email delivered on the first authorization, since the platform does not deliver them again.
- **FR-019**: Users MUST be able to unlock a vault on the phone by entering that vault's recovery phrase.
- **FR-020**: Users MUST be able to unlock a vault by linking the phone to a desktop that is already signed in and unlocked, by scanning a code that desktop displays and confirming a short verification code shown on both screens; the desktop MUST confirm before any key material is transferred.
- **FR-021**: When the account holds more than one vault, the user MUST see every vault listed at the unlock step and choose which to open, and MUST be able to switch to another vault later from settings.
- **FR-022**: All vault content MUST remain end-to-end encrypted on the phone path; the service MUST never be able to read note bodies, titles, or any user content originating from or synced to the phone.
- **FR-023**: Vault secrets MUST be stored only in device secure storage on that device, scoped to this device only and readable from the first unlock after boot until power-off so that background sync and reminder scheduling can run while the screen is locked, MUST never appear in logs, telemetry, crash reports, or backups readable off-device, and MUST never cross into the shell in readable string form.
- **FR-024**: The local store and any downloaded image files MUST be protected at rest by platform file protection in the class that stays readable after the first unlock following boot, so background sync can open the store while the screen is locked, and excluded from off-device backup. Restoring the phone from a backup is therefore not a recovery path; recovery is re-linking or the recovery phrase. The stated security posture is protection against service compromise and against a powered-off or never-unlocked device; forensic extraction of a booted, locked device is not a claimed protection.
- **FR-025**: Users MUST be able to sign out, which locks the vault and removes local vault content and key material from the device.
- **FR-026**: When this device's registration is revoked, the app MUST detect it on next contact with the service, enter a locked state, remove local vault content, and explain why.
- **FR-027**: A failed unlock MUST produce a clear error and leave nothing corrupted or partially unlocked.
- **FR-028**: The app MUST be usable before the first sync completes: recent content first, older content on demand, determinate progress, and app open never blocked on the network.

**Sync, offline durability and safety**

- **FR-029**: Every user-editable capability MUST work fully offline; changes made offline MUST be durably queued, survive force-quit and device restart, and sync completely on reconnect.
- **FR-030**: The shared core MUST persist a change locally before that change is acknowledged to the shell, to the editor surface, or to the user. State that exists only in memory is treated as lost.
- **FR-031**: Concurrent edits to the same item on different devices MUST converge without losing either side's changes: at content level for long-form bodies, at field level for structured items.
- **FR-032**: Every sync request MUST declare the set of item types this client understands, and that set MUST be listed in the protocol specification. An item served outside the declared set MUST NOT fail the page it arrives in and MUST NOT cause the cursor to advance past items that were not processed. A declared name the service does not recognise is dropped silently, and a declaration in which nothing is recognised serves zero rows; the client MUST treat a zero-row first page on a vault known to hold items as a failure to report, never as an empty vault.
- **FR-033**: Item types and fields this client does not recognise MUST be preserved round-trip and never stripped.
- **FR-034**: Every request to the service MUST identify the client platform and version.
- **FR-035**: When the service requires a newer client version, or the per-platform write switch is active, the app MUST enter an explicit read-only mode: writes blocked with a plain explanation and an update path, reads uninterrupted, queued local changes preserved.
- **FR-036**: Changes originating from the phone MUST be attributable service-side by platform and version so an incident can be traced and rolled back.
- **FR-037**: The shell MUST contain no merge logic, no clock or ordering logic, and no cryptographic logic, and MUST NOT talk to the sync service directly. A decision the shell needs is exposed by the core.

**Notes and the editor**

- **FR-038**: Users MUST be able to browse the same folder hierarchy as desktop and open any note in it.
- **FR-039**: Users MUST be able to create, edit, rename, move, and delete notes.
- **FR-040**: The editor MUST render and preserve every type in the shared schema's registry. The registry comprises: default block types `audio`, `bulletListItem`, `checkListItem`, `codeBlock`, `divider`, `file`, `heading`, `image`, `numberedListItem`, `paragraph`, `quote`, `table`, `toggleListItem`, `video`; Memry block types `taskBlock`, `callout`, `file`, `youtubeEmbed`, `bookmark`, `toggleListItem`, where `file` and `toggleListItem` are Memry specifications overriding the defaults of the same name; inline content types `text`, `link`, `wikiLink`, `linkMention`, `hashTag`, `dateMention`, `inlineImage`, `inlineCheckbox`; and styles `bold`, `italic`, `underline`, `strike`, `code`, `textColor`, `backgroundColor`. Required behaviour: every listed type renders and is preserved on save; editing is full for text-bearing types; and `file`, `audio`, `video`, `bookmark`, and `youtubeEmbed` blocks render in place with their existing data but are not creatable on the phone in this feature. The enumerated list MUST be derived from the shared schema's type registry, and a test MUST fail when a type exists in the registry but not in this requirement.
- **FR-041**: A note opened on the phone and closed without an edit MUST produce a byte-identical body when next read on desktop. An edited note MUST change only the serialization of the region the user edited.
- **FR-042**: The app MUST embed exactly the editor bundle built from the shared editor schema it ships against, verified at build time; a build whose embedded bundle and schema are out of step MUST fail rather than ship. At runtime the editor surface MUST refuse to initialise unless the handshake it performs on load proves the loaded bundle matches that schema, and a mismatch MUST be recorded as a counted event.
- **FR-043**: The app MUST refuse to open a note body for editing when the loaded bundle cannot build every node type present in that document. The refusal MUST be stated to the user, reading MUST remain available, and no node may be removed from the document.
- **FR-044**: The shared core MUST own the live document. The editor surface holds a replica, persists nothing, and is not a source of truth for any content.
- **FR-045**: Image block bytes MUST download lazily, defaulting to unmetered connections, with an explicit per-item override. An image whose bytes are not yet present MUST show a placeholder and become visible on arrival without the note being recreated. Image bytes are fetched over the service's attachment channel (content-addressed chunks with a per-file manifest). Cached note bodies and image bytes MUST be bounded rather than accumulating without limit.
  - **Wording corrected by feature 003.** This said "inline image", which in our schema names the table-cell-only `inlineImage` type (chapter 12 §12.7.1) rather than the `image` **block** it meant. Both are covered. The clause "which this feature uses read-only; upload stays out of scope" is removed: feature 003 uploads too.
- **FR-046**: Wiki-links MUST render with their display alias, navigate to their target including heading targets, and offer autocomplete when authoring.
- **FR-047**: Users MUST be able to view, add, and remove tags with letter-case behaviour identical to desktop.
- **FR-048**: Users MUST be able to view and edit note properties; property definitions and value types MUST behave identically to desktop.
- **FR-049**: Users MUST be able to create a note from an existing template.
- **FR-050**: Editing MUST support undo and redo within an editing session.

**Folders, tags and search**

- **FR-051**: Users MUST be able to create, rename, move, and delete folders, with the resulting hierarchy identical to desktop for the same operations.
- **FR-052**: Users MUST be able to browse the vault's tags and see the items carrying each tag.
- **FR-053**: Full-text search MUST cover notes, journal entries, and tasks over all locally synced content, work offline, rank with the same ranking function desktop uses (same tokenizer and the same field weights) over the text the phone extracts from each document, and open the correct item from a result. Identical ordering to desktop is expected whenever the extracted text matches desktop's, and the extraction is covered by a committed vector class.

**Journal**

- **FR-054**: The journal MUST maintain exactly one entry per calendar day; today's entry MUST be reachable in one interaction from app open, and any date MUST be reachable by navigation.
- **FR-055**: Journal entries MUST support the same editing capabilities as notes.

**Tasks and reminders**

- **FR-056**: Users MUST be able to create, edit, complete, and delete tasks with due and scheduled dates, priority, recurrence, and project assignment.
- **FR-057**: Task views MUST include today, upcoming, by-project, and completed, with the same membership semantics as desktop.
- **FR-058**: A task represented as a checkbox inside a note and the same task in task views MUST stay consistent when either is changed on the phone.
- **FR-059**: Concurrent edits to different fields of the same task on two devices MUST both survive.
- **FR-060**: Users MUST be able to see their projects and assign a task to one; creating and editing projects is not available on the phone in this feature and the interface MUST say so rather than fail silently.
- **FR-061**: Reminders MUST fire as device notifications at the scheduled time using already-synced data, including with the app closed or the device offline, and tapping one MUST open the item. A reminder for an item completed or removed elsewhere MUST open a sensible state rather than crash or show a ghost item.
- **FR-062**: When the number of scheduled reminders exceeds what the platform will hold at once, the app MUST schedule the nearest window of reminders, refill that window on every foreground activation and every background refresh, and state the limitation somewhere the user can see it.

**Settings, devices, entitlement and account**

- **FR-063**: Synced user preferences MUST apply on the phone wherever the preference's concept exists; a preference with no equivalent MUST leave its surface in the surface's default state and MUST NOT log an error.
- **FR-064**: Users MUST be able to see the devices registered to their account and remove any of them.
- **FR-065**: An account without an active plan MUST still be able to read its already-synced local content. The unentitled notice MUST state plainly that sync needs an active plan and MUST NOT link to, name a price for, or steer the user toward any external purchase mechanism.
- **FR-066**: Users MUST be able to delete their account from within the app, with the outcome matching existing service-side deletion behaviour.

**Distribution and compliance**

- **FR-067**: The app's privacy disclosures MUST accurately reflect actual data collection; telemetry exists and is not identity-linked, so "collects nothing" is a false statement and MUST NOT be made. Telemetry MUST be switchable off inside the app, and events MUST carry no account identifier or stable device identifier so the disclosure can honestly say the data is not linked to the user.
- **FR-068**: Export-compliance answers MUST be recorded and correct for the cryptography the app contains.
- **FR-069**: The app MUST launch without crashing on every supported device generation.
- **FR-070**: External beta distribution MUST NOT open until the read-only switch has been exercised end to end against the exact build testers will receive.

**Engineering gates and boundary discipline**

- **FR-071**: Phases MUST be gated serially in this order, each with recorded evidence before the next begins: protocol specification, conformance vectors, core parity against the vectors, headless round trip, shell. A phase MUST NOT be marked done without the exact green evidence for its gate.
- **FR-072**: A test that mocks the boundary under examination MUST NOT be cited as evidence that a sync, crypto, storage, or merge path works. Such tests are permitted only as a supplement to a test exercising the real boundary.
- **FR-073**: Every crossing between the shell, the shared core, and the editor surface MUST use a generated typed contract. Untyped or stringly-typed messages at these boundaries are defects.
- **FR-074**: The performance thresholds stated in Success Criteria MUST be treated as release gates; a measured regression against one blocks release with the same force as a failing test.

**Trust and consistency**

- **FR-075**: Shared concepts MUST use the same terminology, semantics, and state transitions as desktop; degraded states, meaning offline, syncing, unentitled, locked, and read-only, MUST be explicit and use the same vocabulary on both shells.
- **FR-076**: Any capability that is absent or read-only on the phone MUST say so in the interface rather than fail silently.
- **FR-077**: The app MUST meet WCAG AA contrast, provide screen-reader labels for all interactive elements, honour reduced-motion and reduced-transparency preferences, support dynamic type, and lay out correctly in RTL languages.

### Key Entities

- **Vault**: an end-to-end encrypted store of content, unlockable by recovery phrase or by linking from an already-unlocked device. An account may hold several; the user chooses which to open and may switch between them. The shared contract between every shell.
- **Device**: a registered participant in sync, identified per request by platform and version, removable by the user, revocable from elsewhere, and the unit the read-only switch and write attribution apply to.
- **Note**: long-form rich content in a folder hierarchy, carrying tags, properties, wiki-links, and inline images; stored as a markdown body whose bytes are part of the contract.
- **Journal entry**: a note-like body bound to exactly one calendar day.
- **Folder**: a named container in the note hierarchy, with the same nesting and move semantics on every shell.
- **Tag**: a label attached to content, with letter-case semantics that must match desktop exactly.
- **Property definition**: the declared name and value type of a note property, shared across the vault.
- **Template**: a reusable note structure applied at creation.
- **Task**: a completable item with dates, priority, recurrence, and optional project, which may also live as a checkbox inside a note; merged field by field.
- **Project**: a grouping of tasks and notes; readable on the phone and assignable to, not creatable or editable there in this feature.
- **Reminder**: a scheduled prompt bound to an item, delivered as a device notification from already-synced data, scheduled within a bounded nearest window.
- **Settings**: synced user preferences, applied per shell where the concept exists.
- **Conformance vector set**: the committed inputs and expected outputs that define correct behaviour for primitives, unlock, envelopes, the pack container, field merges, and markdown round-trips; the shared test both implementations answer to.
- **Protocol specification**: the written document describing the wire formats, routes, item-type negotiation, body serialization, and merge rules; authoritative over any implementation, including the existing one, where the two disagree.

### Out of Scope (this feature)

Scope divergence is explicit per the constitution: each exclusion is a recorded decision with a reason, and each affected surface says so in the interface rather than failing silently.

| Capability                                 | Status                                               | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inbox                                      | Absent                                               | Planned as feature 003 over the same core; capture belongs with triage and neither is required to prove the foundation                                                                                                                                                                                                                                                                                                                                                                                        |
| Calendar                                   | Absent                                               | Planned as feature 003 over the same core; depends on tasks and journal landing first                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Home                                       | Absent                                               | Planned as feature 003 over the same core; it aggregates surfaces that do not all exist yet in this feature                                                                                                                                                                                                                                                                                                                                                                                                   |
| Canvas, including read-only viewing        | Absent                                               | Planned as feature 003 over the same core; the current canvas format is document-bound and a faithful viewer is its own body of work. This narrows the decision record's earlier "read-only at most"; the decision record has been amended to match                                                                                                                                                                                                                                                           |
| Bookmark items (the sidebar feature)       | Absent                                               | Planned as feature 003 over the same core. Bookmark blocks inside notes still render in place with their existing data (FR-040)                                                                                                                                                                                                                                                                                                                                                                               |
| Saved filters                              | Absent                                               | Planned as feature 003 over the same core; depends on the filter expression engine being moved into the shared core                                                                                                                                                                                                                                                                                                                                                                                           |
| Attachments                                | **Superseded by feature 003**                        | This row read: `file`, `audio`, and `video` render metadata in place, their bytes are deferred, and all upload is deferred, with inline images the one exception. Feature 003 overrides it — every attachment type downloads and uploads from the phone. The per-item unmetered override of FR-045 survives unchanged; what is gone is the deferral. See `specs/003-ios-note-parity/plan.md` §3 D4                                                                                                            |
| In-app purchase and billing                | Absent                                               | The existing web entitlement is reused. An account without entitlement sees a plain statement that sync needs an active plan, with no purchase link, no price, and no steering to any external purchase path. Honouring a web-purchased entitlement in a store-distributed build also requires the same plan to be purchasable in-app (guideline 3.1.3(b)); that is a gate for App Store release, not for the TestFlight readiness this feature targets, and is carried into feature 003 with in-app purchase |
| Android                                    | Next feature                                         | Same core, own shell; serialised after iOS ships because development is solo                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Agent Chat                                 | Absent                                               | Depends on spawning local tooling and hosting a local server, which the phone sandbox forbids                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Importers from other apps                  | Absent                                               | Require reading other apps' local data, which the phone sandbox forbids                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Semantic and AI search                     | Absent, full-text search ships                       | The on-device semantic engine has no phone equivalent yet and would need a platform-specific model runtime                                                                                                                                                                                                                                                                                                                                                                                                    |
| System share-sheet capture from other apps | Absent                                               | Depends on the inbox, which is deferred to feature 003                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Push-triggered sync                        | Absent, foreground and periodic background sync ship | No server push infrastructure exists today                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Biometric app lock                         | Absent                                               | An app-level gate, not a change to key storage; deferred until the surfaces it guards exist                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Certificate pinning                        | Absent, recorded as permanent for now                | A bad pin cannot be fixed faster than app review, so the failure mode is worse than the threat it removes                                                                                                                                                                                                                                                                                                                                                                                                     |

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 100% of the committed conformance vectors pass in the second implementation, byte for byte, before any shell work begins.
- **SC-002**: Every question that required reading the existing implementation's source during core development is logged as a specification defect and closed by a specification change; the log has zero open entries at the core-parity gate.
- **SC-003**: 100% of real desktop-created test vaults unlock on the phone by recovery phrase, and separately by device linking, verified before any external testing.
- **SC-004**: The headless round trip completes in both directions, headless to desktop and desktop to headless, in under 5 seconds per direction on a healthy network.
- **SC-005**: A change made on one device is visible on another within 5 seconds on a healthy network, in both directions.
- **SC-006**: Typing in a 50 KB note stays under 50 ms from keystroke to visible character on the performance reference device.
- **SC-007**: On a new device with a 10,000-item vault on Wi-Fi, the user can browse and open recent content within 2 minutes of unlocking, and app open is never blocked on the network thereafter.
- **SC-008**: Zero data loss across the offline matrix: offline edits followed by force-quit, restart, and reconnect sync completely in 100% of test runs.
- **SC-009**: The editor bundle mismatch counter reads zero across all testing and beta, and zero note bodies are opened for editing by a build whose loaded bundle cannot build every node type in the document.
- **SC-010**: After 7 days of parallel phone and desktop use by beta users on their real vaults, an automated comparison of content digests for a sample of at least 50 items per beta account, taken on both shells, matches in 100% of sampled items, with zero corrupted items reported.
- **SC-011**: For reminders inside the currently scheduled window, a notification fires within 1 minute of its scheduled time in 99% of cases, including with the app closed.
- **SC-012**: The build is accepted for external beta distribution with accurate privacy declarations, correct export-compliance answers, and in-app account deletion present.
- **SC-013**: Accessibility audit passes: WCAG AA contrast, screen-reader labels on all interactive elements, reduced motion honoured, dynamic type supported, RTL layout correct.
- **SC-014**: Every unknown item type and unknown field written by a newer desktop survives a phone round trip unchanged in 100% of test cases, and no result page containing an unprocessed item is recorded as processed.
- **SC-015**: Search returns its first page in under 300 ms at the 95th percentile on a 10,000-item vault on the performance reference device, in the same order desktop returns for the same query and corpus.
- **SC-016**: Boundary traffic stays inside its ceilings under a sustained 10-keystrokes-per-second typing test: the shell-to-editor flush cadence is no faster than one envelope every 24 ms with each envelope at most 256 KB before encoding, and the shell-to-core boundary makes no per-keystroke call.

## Assumptions

- Technology choices are fixed by the decision record `docs/ideas/2026-09-12-native-ios-rust-core-plan.md` and are not open questions in this spec: the shared core is a Rust crate (`crates/memry-core`) exposed to shells through UniFFI; the iOS shell is SwiftUI targeting iOS 26 and later (`apps/ios`); collaborative documents use `yrs`, which is wire-compatible with the desktop's Yjs bytes; cryptography uses libsodium, the same C library the desktop reaches through its own binding; the note editor is the existing WebView-hosted BlockNote bundle built from `packages/editor-web` (moved out of the frozen `apps/mobile` as part of this feature), reached over the existing bridge protocol in `packages/contracts/src/webview-bridge.ts` at version 1, unchanged.
- The desktop app does not change in service of this feature. The sync server changes only additively: an Apple identity provider for Sign in with Apple, the test-suite wiring that verifies the conformance vectors, and nothing else. The protocol specification and the vectors themselves live in the shared contracts package. Any shared TypeScript touched leaves the desktop and sync-server suites green in the same change.
- `packages/contracts` remains the schema source of truth. Where the second implementation and a contract disagree, the second implementation is the defect.
- The item types this phone subscribes to in this feature, using the exact strings in `RECORD_SYNC_ITEM_TYPES` from `packages/contracts/src/sync-api.ts`, are: `note`, `journal`, `folder_config`, `custom_icon`, `tag_definition`, `tag_category`, `property_definition`, `template`, `task`, `project`, `task_activity`, `reminder`, `settings`. Every other record type is served but not subscribed to, and FR-032 governs what happens when one arrives anyway. Collaborative-document bodies and attachment bytes travel their own channels and are not governed by this declaration.
- `apps/mobile` is frozen and reference-only: it is consulted for the platform seam shapes, the WebView bridge host, and the editor bundle build, and nothing new depends on it. `specs/001-mobile-app/spec.md` is superseded and its unchecked tasks are closed rather than migrated. `specs/001-mobile-app/contracts/` is exempt from that supersession and remains the normative location for the bridge and adapter contracts until they are restated elsewhere.
- The unentitled-state wording and the no-steering rule follow `specs/001-mobile-app/apple-review-memo.md`, which is the reviewed source for this language. Its double-subscription notice does not apply here because no purchase happens on the phone in this feature.
- App Review guideline 4.8: because Google sign-in is offered, the guideline requires an equivalent option that lets users keep their email address private, which the email one-time-code account cannot promise. Sign in with Apple is therefore in scope for this feature (FR-018), including the service-side verification of Apple identity tokens and the handling of private relay addresses. A relay address cannot be matched to an existing account by email, so the Apple option MUST offer an explicit "link to an existing account" step that verifies the real address with a one-time code before linking; the user's name and email arrive only on the first authorization and MUST be persisted then. Google sign-in on the phone uses the system web-authentication session with a code-plus-verifier flow and no vendor sign-in library, because the vendor library's privacy manifest declares linked device-identifier and location collection that this product will not put on its listing.
- Android follows as its own feature over the same core, after iOS ships. All protocol and core requirements in this spec apply to it unchanged; the shell requirements are re-expressed in that platform's own patterns.
- Development is solo, so phases are serial with a green gate between them, per the constitution: protocol specification, then vectors, then core parity against vectors, then the headless round trip, then the shell. No shell work runs in parallel with an unmet foundation gate.
- If schedule pressure hits, the first recorded cut is reminders. The second cut is device linking by scanned code; taking that cut removes FR-020 and the linking half of SC-003 and MUST be recorded as a spec amendment before implementation stops. The recovery phrase unlock path is not cuttable, because without it an existing vault cannot be opened at all. A zero-risk alternative recorded here: the phone may ship with the email one-time code as its only sign-in; accounts are keyed by email on the service, so a Google-created account signs in with the same address, and with no third-party login offered App Review 4.8 does not apply. Taking that cut removes the Google and Apple halves of FR-018 and MUST be recorded as a spec amendment.
- Supported devices are every iPhone that runs the minimum operating system version the app targets. The performance reference device for every stated threshold is an iPhone two generations behind the newest model at feature start, which is the iPhone 15, measured on a release build.
- Existing desktop users are the primary audience. Creating a brand-new vault from the phone is possible through the existing account and vault creation flows, but the bet is companion use alongside a desktop.
