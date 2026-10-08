# iOS guide

This directory owns the native iOS app, a SwiftUI shell over the Rust core in [crates](../../crates/AGENTS.md). The app is in development and unreleased. Its current code and Figma files do not override `DESIGN.md` or desktop. When iOS and desktop disagree on product behavior, desktop is right until Kaan says otherwise.

## Ownership

- The shell holds screens, navigation, platform integrations, and thin adapters. Sync, crypto, CRDT, storage, auth, and domain rules live in the core and arrive through `import MemryCore` (`packages/swift/MemryCore`). When a screen needs a decision the core does not expose, add a core API instead of Swift logic.
- `Memry/Seams` implements the core's platform traits, including `Transport`, `TransportHTTP`, `TransportSocket`, and `Keychain`. Network calls go through these transports. `check:architecture` flags `URLSession` anywhere else in `Memry/`.
- `Memry/App` holds the app lifecycle and composition root, `Memry/Core` holds events, the executor, logging, and error mapping, `Memry/Features` holds the feature modules, `Memry/Editor` holds note editing, and `Memry/Design` holds tokens and shared UI. `MemryShare` is the share extension.
- Generated code is regenerated, never hand-edited. The Swift bindings come from `crates/memry-core/build-xcframework.sh`. `Memry/Resources/BlockRender.bundle` (KaTeX, mermaid) and `Whiteboard.bundle` (Excalidraw) come from `scripts/generate-block-render.mjs` and `scripts/generate-whiteboard.mjs`, which copy the versions desktop resolves.
- The root `scripts/check-line-ceilings.mjs` caps each file in `Memry/Features` at 400 lines. Split a file at the ceiling before adding to it.

## Build and simulators

- After a core change, run `crates/memry-core/build-xcframework.sh` before building, or Swift links against a stale core. `pnpm dev:mobile` does this first.
- Agents build, test, and install only on `-destination 'platform=iOS Simulator,name=iPhone 17'`. `iPhone 17 Pro` runs Kaan's `pnpm dev:mobile` hot-reload session, and any `xcodebuild test` or `simctl install` there kills his running app. Never touch it.
- There is no pnpm entry point for tests. Use `xcodebuild` with the `Memry` scheme:

```bash
xcodebuild test -project apps/ios/Memry.xcodeproj -scheme Memry -testPlan Unit \
  -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:MemryTests/<TestClass>
```

## Tests

Run the narrowest of the three plans that covers the change:

- `TestPlans/Unit.xctestplan` runs `MemryTests`.
- `TestPlans/Conformance.xctestplan` runs `MemryConformanceTests`, which hold iOS to the same protocol and domain behavior as desktop through the shared vectors. A failure here means iOS diverged, not that the test is wrong.
- `TestPlans/UI.xctestplan` runs `MemryUITests`.

Test gotchas:

- The Unit plan runs inside the app on the shared simulator, and its sign-out tests wipe the app's keychain. Anything that needs a signed-in app, such as the UI plan or a manual check, comes after a fresh sign-in, never straight after a Unit run.
- Before signing in to the staging test account, whether for iOS sign-in, an OTP, a recovery phrase, or a desktop launched on staging to pair or sync, read `.pi/skills/staging-test-account/SKILL.md`.
- `TasksUITests` needs the simulator signed in to the staging test account. It fails, rather than skips, when it lands on sign-in.
- `JournalUITests` needs the same sign-in plus the synced journal settings its header names, a Wednesday template. It pins today with `-MEMRY_JOURNAL_TODAY <date>`, always a day in 2099.
- An editable block is a text view, so its text is the accessibility value, not the label. Match `label CONTAINS x OR value CONTAINS x`.
- `XCUIApplication.typeKey(.escape)` does not reach the app on the simulator. Drive `.cancelAction` shortcuts with `⌘.` instead.

## Swift

- Force unwraps (`!`) and `try!` stay in tests. An optional that is "always there" is next month's crash report.
- Errors map through `Memry/Core/ErrorMapping.swift`. Show the user the mapped message, never a raw Swift error string.
- Log through `Memry/Core/Log.swift`, not `print`.
- `UNUserNotificationCenterDelegate` uses the completion-handler methods and finishes on the main actor. With the `async` forms, the system can complete a tapped notification off the main thread, and UIKit terminates the app.
- A `List` that reorders with `onMove` cannot own a multi-selection (`List(selection:)` with a `Set`). The list then turns every drag into a drag session and never calls `onMove`. Keep the selection in the view.
- Observe `scenePhase` at the vault scope, not inside a tab. A hidden tab's views miss scene changes.
- iOS stores notification text in plaintext outside the vault. A task title may go in a notification title. Note and reminder text never goes in a notification body (R12 in `specs/002-native-foundation-ios/research.md`).

## Design

- Read `DESIGN.md` before any UI change. iOS adapts the desktop reference through system navigation and controls, and keeps desktop's vocabulary and semantics for every shared concept.
- Dynamic Type, VoiceOver labels, reduced motion, and WCAG AA contrast are baseline requirements.

## Data

- Vault files and sync payloads may come from a desktop build newer or older than this one. Accept both, and never rewrite a vault as a side effect of reading it.
- Anything the server checks against a device, such as a pushed record's signer or an attachment manifest's signer, uses the server-registered id from the access token's `device_id` claim (`AuthSession::registered_device_id`). The local id derived from the signing key only names this device inside field clocks, and the server rejects it with `AUTH_DEVICE_NOT_FOUND`.
- A write that should reach other devices schedules a sync pass. Task writes do it through `TasksStore`, and other screens call the `requestVaultSync` environment action.
- A sync pass pulls bodies only for the records it applied, and desktop pushes a body edit as CRDT updates with no record. A screen showing a document another device edits pulls that body itself with `VaultFilling.fetchNoteBody` when it appears and after each sync pass, as the journal day page does.
- Backlinks and link targets read the search index. Reindex with `VaultSearching.reindex` after a sync pass on any screen that shows them.
- Address a journal day by its date, never by `j<date>`. Days written by older desktops carry other ids, and every write goes to the existing record's id.
- Journal tag and property writes stay off (`JournalWriteGate.metadataWrites`) until the oldest desktop in use includes the JP029a handler fix (`specs/005-ios-journal-parity/tasks.md`). Earlier desktops empty the day's file on a record-only change.
- `BlockEdit.setText` edits a single plain run in place, so a peer's concurrent typing in the same block survives. Keep plain-text edits on that path instead of replacing the whole run.
