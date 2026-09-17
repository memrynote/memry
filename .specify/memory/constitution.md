<!--
Sync Impact Report
==================
Version change: 1.0.0 → 2.0.0 → 2.1.0 → 2.2.0 (2026-09-12, same day)
Bump rationale: MAJOR. Principle I is redefined: the shared core moves from
TypeScript packages consumed by a React Native shell to a Rust crate consumed
by native Swift and Kotlin shells. The Mobile Platform Constraints section is
rewritten for that architecture. Work that was compliant under 1.0.0 (RN code
in apps/mobile reaching @memry/* packages) is no longer the target.

Modified principles:
  - I. Shared Core, Platform Adapters → I. One Core, Native Shells (NON-NEGOTIABLE)
  - II. Code Quality Is A Gate, Not A Preference (boundary list updated)
  - III. Test The Seam That Can Lose Data (protocol spec + composite vectors
    added as prerequisites; Rust conformance replaces RN JSI parity)
  - IV. One Product, Two Shells → IV. One Product, Native Shells
  - V. Performance Is A Budget With Numbers (boundary names updated)

Added sections:
  - Frozen React Native Shell (inside Mobile Platform Constraints)

Removed sections: none

Migration note (required for MAJOR):
  - apps/mobile is frozen as of 2026-09-12. No new commits land there except
    deletions. It stays in-tree as reference for the platform adapters, the
    WebView bridge host, and the editor bundle build.
  - specs/001-mobile-app is superseded by specs/002-native-foundation-ios.
    Its unchecked tasks are closed, not migrated.
  - scripts/check-architecture-boundaries.js mobile reachability gate remains
    until apps/mobile is deleted; it is not extended to new shells.
  - Decision record: docs/ideas/2026-09-12-native-ios-rust-core-plan.md

2.2.0 (MINOR): Storage-of-record constraint restated: the core stores the
  collaborative document and derived text, never markdown; conversion lives
  in the editor surface. Follows Phase 1 design review for feature 002.
2.1.0 (MINOR): Keys constraint clarified to the after-first-unlock class with
  the stated security posture; editor bundle lockstep gains the load-time
  handshake. Both follow Phase 0 research for feature 002.

Deferred / TODO items: none
-->

# Memry Constitution

Memry is one product on native shells: a shipped Electron desktop app with
real users and real vaults, and native mobile apps, iOS first
(`apps/ios`, SwiftUI) then Android (`apps/android`, Jetpack Compose), built
over one shared Rust core (`crates/memry-core`). Every shell reads and writes
the same end-to-end encrypted vault through the same sync server. These
principles govern the mobile work, the Rust core, and any desktop or server
change that work touches.

## Core Principles

### I. One Core, Native Shells (NON-NEGOTIABLE)

Everything that is not UI lives once, in `crates/memry-core`, and is exposed
to shells through UniFFI. A shell contains screens, navigation, platform
integrations, and thin adapters. A shell MUST NOT reimplement sync, crypto,
CRDT, storage, auth, or domain rules.

Rules:

- Swift and Kotlin code MUST NOT talk to the sync server directly, MUST NOT
  hold key material outside the platform secure store adapter, and MUST NOT
  contain merge, conflict, or clock logic. If a shell needs a decision the
  core does not expose, the core gains an API; the shell does not gain logic.
- Platform-specific capability (secure store, file protection, notifications,
  background execution, network reachability, network transport, WebView
  hosting, camera) sits behind
  an adapter trait defined by the core and implemented by each shell. The set
  of adapters is enumerated in the feature spec; adding one requires written
  justification.
- The desktop app stays TypeScript. The protocol therefore has two
  implementations, TypeScript and Rust. Their agreement is proven by shared
  conformance vectors, never by reading the other implementation.
- `packages/contracts` remains the schema source of truth. Rust types are
  derived from or checked against those schemas; a Rust type that drifts from
  a contract is a defect in the Rust, not an alternative.
- Vault bytes are the contract. Note bodies, crypto envelopes, sync payloads,
  and settings shapes MUST be byte-compatible across shells and versions.
  Backward compatibility with data written by older app versions is
  mandatory; schema and format changes MUST be additive and verified against
  existing rows.

Rationale: the vault is shared and live. The React Native shell re-derived
domain logic by hand and shipped a type mismatch that made every phone edit
invisible to desktop. One core is how that class of defect stops existing.

### II. Code Quality Is A Gate, Not A Preference

Every change MUST pass lint, typecheck, architecture-boundary, and contract
checks before merge. For Rust: `cargo fmt --check`, `cargo clippy` with
warnings denied, and the crate's test suite. For Swift and Kotlin: the
platform linter and the shell's test target. A red gate is never waived by
assertion; it is fixed or the change does not land.

Rules:

- No `console.*` or `print` in shipped code; use the project logger on each
  platform. No user-facing raw error objects; errors cross the FFI as typed
  variants and are rendered by the shell.
- Cross-boundary calls MUST be typed through a generated contract:
  renderer↔main on desktop via `packages/contracts`, shell↔core via UniFFI
  definitions, shell↔WebView via `packages/contracts/src/webview-bridge.ts`.
  Hand-written `Any`, `Dictionary<String, Any>`, or stringly-typed messages
  at a boundary are defects.
- New UI code MUST use logical layout properties (leading/trailing,
  start/end) so RTL works without a second layout pass.
- Changes MUST be surgical: every changed line traces to the stated intent.
  Adjacent refactors, formatting sweeps, and speculative abstractions belong
  in their own change.
- A file that has grown past its module's stated ceiling MUST be split
  before new behaviour is added to it.

Rationale: three languages over one encrypted store means defects are
expensive to observe and worse to reverse. The cheapest place to catch them
is the gate.

### III. Test The Seam That Can Lose Data (NON-NEGOTIABLE)

Testing effort MUST be spent where a failure destroys user data, not where
coverage is easiest to add.

Rules:

- The protocol MUST be specified in writing and covered by conformance
  vectors before the Rust core implements it. Vectors are generated by the
  TypeScript implementation, verified by the desktop test suite, and
  committed. They MUST cover primitives, the vault-unlock flow, the signed
  record envelope, the packed CRDT update, the pack container, and the
  field-merge heuristics.
- Crypto and envelope parity is a hard gate. The Rust core MUST reproduce
  every committed vector byte for byte before any feature work proceeds. A
  vault that does not open is a total product failure.
- Every sync path — outbox persistence, CRDT merge, conflict resolution,
  delete and tombstone handling, offline-then-reconnect, kill-switch
  read-only mode — MUST have an automated test that exercises the real
  adapter and, where possible, the real staging server. Mocked-boundary tests
  are permitted only as a supplement; they MUST NOT be cited as evidence
  that a boundary works.
- The Rust core MUST prove a full round trip headless, as a CLI against
  staging with a real desktop on the other side, before any shell UI depends
  on it.
- A bug fix MUST ship with a test that fails before the fix.
- No phase, task, or checklist item is marked done without the exact green
  verification evidence for it. "Should be fine" is not evidence.
- Beta testing on real user vaults MUST NOT open until the write path has
  been exercised behind an active server-side kill switch.

Rationale: a mobile write bug does not stay on mobile. It syncs into the
user's desktop vault.

### IV. One Product, Native Shells

Mobile is a different shape of the same product, not a different product.
Shared concepts MUST behave identically; only the interaction model adapts to
the platform.

Rules:

- Terminology, iconography, item semantics, and state transitions MUST match
  desktop for every shared concept. The same action MUST produce the same
  result on every shell.
- Shells use system navigation and system controls. Navigation bars, back
  buttons, tab bars, toolbars, sheets, search fields, and context menus are
  the platform's own components, styled within what the platform allows.
  Reimplementing desktop chrome on a phone is a violation, and so is porting
  a phone pattern back to desktop for consistency's sake.
- iOS and Android are allowed to differ from each other where the platform's
  visual language differs. They MUST NOT differ in vocabulary, semantics, or
  what a user can do.
- Scope divergence MUST be explicit and justified in writing, never
  emergent. A capability that is read-only or absent on mobile MUST say so
  in the UI rather than fail silently.
- The product's character governs every shell: calm, private, restrained.
  No gamification, no attention-seeking motion, no dark patterns around
  billing or permissions.
- Accessibility is not platform-conditional. WCAG AA contrast, reduced
  motion and reduced transparency, platform screen-reader labelling, dynamic
  type, and RTL layout are required on every shell.
- Degraded states — offline, syncing, unentitled, locked, read-only by kill
  switch — MUST be represented with the same vocabulary and the same visual
  weight on every shell.

Rationale: users move between phone and desktop within a single train of
thought. Any inconsistency in a shared concept reads as a bug in the vault.

### V. Performance Is A Budget With Numbers

Performance targets MUST be stated as measurable thresholds, measured on
real hardware, and treated as release gates.

Rules:

- Typing in a note MUST stay under 50 ms keystroke-to-render on a 50 KB
  note on a mid-tier device.
- A write on one device MUST become visible on another in under 5 seconds
  on a healthy network.
- Cross-boundary traffic MUST be batched on both ends. Per-keystroke or
  per-update message passing across the shell↔WebView bridge, the
  shell↔core FFI, or the desktop renderer↔main boundary is a defect
  regardless of measured comfort on a fast device.
- Any operation that can exceed 1 second MUST be incremental, cancellable,
  or show determinate progress. Blocking app open on a full index or a full
  body download is forbidden.
- Startup MUST NOT be gated on the network. First sync on a new device
  fetches metadata plus a recent-body window; the remainder loads on demand,
  and attachments stay lazy and Wi-Fi-first by default.
- Memory and battery are budgets too: no unbounded in-memory caches of note
  bodies or attachment bytes, and no polling loop that runs while the app is
  backgrounded.
- A performance regression against a stated threshold blocks release with
  the same force as a failing test.

Rationale: on a phone, a slow app is a broken app, and the platform will
kill a process that ignores its budgets, taking unsynced writes with it.

## Mobile Platform Constraints

These constraints apply to `crates/memry-core`, `apps/ios`, `apps/android`,
and any shared code they reach.

- **Storage of record**: SQLite owned by the core, not files. A note body
  is its collaborative document: the core stores the update log and
  snapshots, plus derived plain text for search and previews. The core never
  serialises or parses the body's markdown; markdown⇄block conversion runs
  only inside the editor surface, for seeding a new note and for export. The
  phone never writes vault files; desktop materialises them from the shared
  document. Attachment bytes are sandbox files with platform file
  protection, never database blobs.
- **Durability across process death**: the sync outbox and CRDT state MUST
  be persisted to SQLite by the core before any acknowledgement reaches the
  shell or the WebView. Any state that only exists in memory is assumed
  lost, because the OS may kill a backgrounded app at any moment.
- **CRDT ownership**: the Rust core owns every Y.Doc through yrs, mirroring
  desktop's main-process ownership. The note editor is a WebView hosting the
  BlockNote bundle; it holds a replica and persists nothing. WebView-owned
  document state backed by web storage is rejected.
- **Editor bundle lockstep**: the shell embeds the editor bundle built from
  the shared editor schema. A schema change MUST ship in the same release as
  the bundle that can build it, gated by a build-time hash check and a
  load-time handshake that refuses to initialise a mismatched bundle. A bundle
  that cannot build a node type deletes that node from the shared document
  and replicates the deletion; shipping such a bundle is data loss, not a
  rendering gap.
- **Keys**: secrets live in the platform secure store (Keychain, Keystore),
  scoped to this device only and readable from the first unlock after boot
  until power-off, reached through a core adapter. That class, not
  "while unlocked", is required because background sync and reminder
  scheduling run while the screen is locked; an optional app-level biometric
  lock gates the UI, not the keys. The stated posture protects against
  service compromise and a powered-off device, not against forensic
  extraction of a booted, locked device. Keys are never written to the
  database, logs, telemetry, or crash reports, and never cross the FFI in
  string form.
- **Production protection before exposure**: mobile clients MUST identify
  themselves per request, MUST be blockable by a server-side minimum-version
  rule, MUST be droppable to read-only by a per-platform kill switch, and
  their writes MUST be attributable server-side so an incident can be traced
  and rolled back. This ships before any external tester writes to a real
  vault.
- **Store compliance is a planned deliverable, not a submission-week
  scramble**: export-compliance and privacy manifests, accurate privacy
  labels, and in-app account deletion. Telemetry exists; declaring "we
  collect nothing" would be false. Declare accurately.
- **Billing honesty**: a user can hold an active subscription on more than
  one platform. The app MUST detect and surface that state plainly rather
  than silently double-charging and absorbing the refunds.
- **Fallback paths are decisions, not accidents**: any capability the
  platform cannot support MUST be recorded with its reason and its
  user-visible behaviour before the dependent work starts. Agent Chat,
  importers, semantic search, canvas editing, and certificate pinning are
  recorded as out of scope in the decision record.
- **Frozen React Native shell**: `apps/mobile` accepts no new commits except
  deletions. It is reference material for adapter shapes, the WebView bridge
  host, and the editor bundle build. Nothing new depends on it.

## Development Workflow & Quality Gates

- **Phase gates are serial.** A phase does not start until the prior
  phase's stated gate is green with evidence. Foundational phases — protocol
  specification, conformance vectors, Rust core parity, headless round trip —
  are never skipped or run in parallel with shell UI work.
- **Risk is retired first.** Unverified native dependencies, FFI
  throughput, WebView keyboard and toolbar behaviour, build-system unknowns,
  and boundary-throughput questions are proven in a spike before any product
  code depends on them.
- **Definition of done** for a change: lint, typecheck or clippy, unit and
  integration tests, architecture and contract checks, binding regeneration
  where UniFFI definitions moved, and documentation for anything
  user-visible or agent-relevant.
- **Desktop and server stay green.** Any change made to shared TypeScript in
  service of the native work MUST leave the desktop and sync-server suites
  green in the same change. "Mobile-only" is not a category for shared code.
- **Scope reduction is a written decision.** When schedule pressure hits,
  the cut is recorded with what was dropped and why. Silently shipping less
  is a violation; quietly shipping it untested is worse.
- **Reviews check compliance with this constitution**, not only
  correctness. A reviewer MUST name the principle a change violates, and
  complexity that appears to violate a principle MUST carry a written
  justification.

## Governance

This constitution supersedes ad-hoc practice, habit, and prior convention.
Where it conflicts with a project guide or a tooling default, this document
wins; where it is silent, `CLAUDE.md` and the per-context docs provide
runtime guidance.

**Amendment procedure.** Amendments are proposed as a change to this file,
state the problem the current text causes, and are approved by the project
owner. Any amendment that invalidates in-flight work MUST include a migration
note saying what changes and by when.

**Versioning policy.** Semantic versioning applies to this document:

- **MAJOR** — a principle is removed or redefined in a way that invalidates
  previously compliant work.
- **MINOR** — a principle or section is added, or existing guidance is
  materially expanded.
- **PATCH** — clarification, wording, or typo fixes with no change in
  meaning.

**Compliance review.** Compliance is verified at review time on every change
and re-examined at each phase gate. Repeated exceptions to the same principle
are treated as a defect in this document and MUST be resolved by amendment
rather than by accumulating unwritten exceptions.

**Version**: 2.2.0 | **Ratified**: 2026-08-22 | **Last Amended**: 2026-09-12
