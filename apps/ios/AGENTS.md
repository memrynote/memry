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

## Swift

- No force unwrap (`!`) outside tests, and no `try!`. An optional that is "always there" is the crash report you read next month.
- Errors map through `ErrorMapping.swift`; do not surface a raw Swift error string to the user.
- Logging goes through `Memry/Core/Log.swift`, never `print`.
- Keep platform code inside `Memry/Features` and `Memry/App`. Shared domain logic belongs behind a seam so conformance tests can hold it to the same contract as desktop.

## Design

- Read `DESIGN.md` before any UI change. Mobile adapts the desktop reference through native iOS patterns; it does not reinvent the product.
- Use logical layout properties (`leading`/`trailing`, never `left`/`right`) so RTL works.
- Dynamic Type, VoiceOver labels, reduced-motion, and WCAG AA contrast are baseline, not polish.

## Data

- Same guarantees as every other surface: offline-first, E2E encrypted, server sees no plaintext.
- Vault files and sync payloads may have been written by a desktop version newer or older than this build. Tolerate both; never rewrite a vault as a side effect of reading it.
