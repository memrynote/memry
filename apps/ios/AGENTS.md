# iOS Rules

Native iOS app (`apps/ios`, Xcode project). Root `AGENTS.md` applies where it is platform-neutral; this file adds iOS rules.

## Status

Mobile is in development and unreleased. Its current code and Figma files do not override `DESIGN.md` or the desktop reference implementation. When mobile and desktop disagree on a product behavior, desktop is right until Kaan says otherwise.

## Layout

- `Memry/App` — app lifecycle, entry, composition root.
- `Memry/Core` — events, executor, logging, error mapping (`ErrorMapping.swift`, `ErrorMappingSync.swift`).
- `Memry/Features` — feature modules.
- `Memry/Editor` — note editing.
- `Memry/Design` — tokens and shared UI.
- `Memry/Seams` — boundaries against the shared core; the place to look before you fake a dependency.
- `Memry/Generated` — generated sources. Never hand-edit; fix the generator.
- `packages/swift` — shared Swift code from the monorepo.

## Tests

Three test plans, run the narrowest that covers the change:

- `TestPlans/Unit.xctestplan`
- `TestPlans/Conformance.xctestplan` — `MemryConformanceTests`, cross-platform behavior parity. A failure here means iOS diverged from the agreed protocol or domain behavior, not that the test is wrong.
- `TestPlans/UI.xctestplan` — `MemryUITests`.

If you create or modify a test, run it and iterate until it passes. There is no pnpm entry point; drive builds and tests through `xcodebuild` or Xcode.

- The Unit plan runs inside the app on the shared simulator, and its sign-out tests wipe the app's keychain. Anything that needs a signed-in app (the UI plan, manual simulator checks) comes after a fresh sign-in, never straight after a Unit run.
- `TasksUITests` needs the simulator signed in to the staging test account; it fails, rather than skips, when it lands on sign-in.
- `JournalUITests` needs the same sign-in plus the synced journal settings its header names (a Wednesday template); it pins today with `-MEMRY_JOURNAL_TODAY <date>`, always a 2099 day.
- An editable block is a text view: its text is the accessibility **value**, not the label. Match `label CONTAINS x OR value CONTAINS x`.
- `XCUIApplication.typeKey(.escape)` does not reach the app on the simulator; drive `.cancelAction` shortcuts with ⌘. instead.

## Swift

- No force unwrap (`!`) outside tests, and no `try!`. An optional that is "always there" is the crash report you read next month.
- Errors map through `ErrorMapping.swift`; do not surface a raw Swift error string to the user.
- Logging goes through `Memry/Core/Log.swift`, never `print`.
- Keep platform code inside `Memry/Features` and `Memry/App`. Shared domain logic belongs behind a seam so conformance tests can hold it to the same contract as desktop.
- `UNUserNotificationCenterDelegate`: implement the completion-handler methods and finish on the main actor. The `async` forms let the system complete a tapped notification off the main thread, and UIKit terminates the app.
- A `List` that reorders with `onMove` must not own a multi-selection (`List(selection:)` with a `Set`): the list then turns every drag into a drag session and never calls `onMove`. Keep the selection in the view.
- Observe `scenePhase` at the vault scope, not inside a tab: a hidden tab's views miss scene changes.
- Notification text is stored by iOS in plaintext outside the vault. A task title may go in a notification title; note or reminder text never goes in a body (spec 002 research R12).

## Design

- Read `DESIGN.md` before any UI change. Mobile adapts the desktop reference through native iOS patterns; it does not reinvent the product.
- Use logical layout properties (`leading`/`trailing`, never `left`/`right`) so RTL works.
- Dynamic Type, VoiceOver labels, reduced-motion, and WCAG AA contrast are baseline, not polish.

## Data

- Same guarantees as every other surface: offline-first, E2E encrypted, server sees no plaintext.
- Vault files and sync payloads may have been written by a desktop version newer or older than this build. Tolerate both; never rewrite a vault as a side effect of reading it.
- Anything the server checks against a device (a pushed record's signer, an attachment manifest's signer) uses the server-registered id, the access token's `device_id` claim (`AuthSession::registered_device_id`). The local id derived from the signing key only names this device inside field clocks; the server rejects it as `AUTH_DEVICE_NOT_FOUND`.
- Any write that should reach other devices schedules a sync pass: task writes do it through `TasksStore`, and other screens call the `requestVaultSync` environment action.
- A sync pass pulls bodies only for records it applied, and desktop pushes a body edit as CRDT updates with no record. A screen that shows a document another device edits pulls that body itself (`VaultFilling.fetchNoteBody`) when it appears and after each sync pass, as the journal day page does.
- Backlinks and link targets read the search index. Reindex after a sync pass on any screen that shows them (`VaultSearching.reindex`).
- Address a journal day by its date, never by `j<date>`: days written by older desktops carry other ids, and every write goes to the existing record's id.
- Journal tag and property writes stay off (`JournalWriteGate.metadataWrites`) until a desktop release with spec 005-journal JP029a is the oldest one in use: earlier desktops empty the day's file on a record-only change.
- `BlockEdit.setText` edits a single plain run in place so a peer's concurrent typing in the same block survives. Do not reintroduce a whole-run replace for plain text.
