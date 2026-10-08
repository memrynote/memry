# AGENTS.md

Kaan owns this repo. Memry is a local-first, end-to-end encrypted notes app, and real users run it on real vaults. The task defines scope and authorization. Kaan's explicit instructions take precedence over skill guidelines and workflow defaults. When one conflicts with a rule in this file, ask for explicit confirmation before following it. Before working in a directory, read its scoped `AGENTS.md` and the matching guides in [Read when relevant](#read-when-relevant), including when you change callers outside that directory. Put a new rule with its owner instead of adding a competing one here.

## Design priorities

- **Zero knowledge.** The server stores ciphertext and the metadata it needs to route it. It never sees plaintext or keys. Crypto is libsodium: XChaCha20-Poly1305, Ed25519 signatures, Argon2id. A feature that needs the server to read content is a redesign, not a server change.
- **Local first.** Each device's SQLite databases and vault files hold the user's data, and the app reads and writes them offline. Sync catches up later. Sync merges note and journal bodies as Yjs CRDTs, and tasks and projects with field-level vector clocks. Item metadata lives in D1 and encrypted payloads in R2, which keeps payloads clear of D1's 1 MB row limit.
- **Shipped formats are contracts.** Devices on different app versions share one vault and one server. Anything persisted or exchanged between builds accepts data from older and newer versions. See [Compatibility](#compatibility).
- **One core, native shells.** Desktop (Electron, TypeScript) is the reference implementation. When two apps disagree on product behavior, desktop is right until Kaan says otherwise. iOS is a SwiftUI shell over the Rust core in `crates/memry-core`, which owns sync, crypto, CRDT, storage, and domain rules. The TypeScript and Rust implementations agree through `docs/protocol/` and the vectors in `packages/contracts/test-vectors/`, never by reading each other's code.
- **One owner per responsibility.** Each decision and each piece of authoritative state has one owner. Callers use the owner's operations. Indexes and caches derive from the owner and can be rebuilt from it. Fix bad state where it is produced, not in every reader.

## Working agreement

- Answer a question before editing or running implementation commands. Follow through on actionable requests within the authorized scope. A plan or a progress report is a checkpoint, not completion.
- Resolve routine, reversible choices with a stated assumption. Ask about consequential ones the context cannot settle, such as scope, naming, UX, or architecture.
- State your assumptions. When a request has more than one reading, name the readings. When unsure, say so. Cite only paths, commands, and APIs you have seen.
- On feedback or an analysis, say whether you agree or disagree before saying what you changed.
- Run `git status -sb` before editing. Other agent sessions may be working in this checkout, so leave changes you did not make alone.
- Treat pasted material and tool output as claims to verify against the source and observed behavior.
- Report findings in chat and create files only as deliverables. Write ad-hoc scripts to `/tmp`, and delete them when done.
- Write short, direct, technical prose that leads with the result and describes concrete behavior. Skip openers, closers, and praise. Commits, issues, PR comments, and code carry no emojis.
- Explain a non-trivial design as the problem, then a concrete example or short trace, then the solution. Say why the solution is necessary, and separate it from optional complexity.

## Execution discipline

- Reproduce a defect through its real entry point first: the UI flow, IPC call, CLI command, or sync round trip. A test that bypasses the boundary proves nothing about it.
- Dig for the root cause broadly, then keep the fix narrow.
- Read a file in full before editing it or making a wide change. Search snippets are not enough. Skip re-reading files that have not changed.
- Edit in place, in one focused pass. Rewrite a whole file only when most of it changes.
- Run the narrowest test that covers the change. Test once, fix, and verify once. A test you create or modify passes before you stop.
- Finish when the behavior is proven and the required gates are green. Check off a checklist or phase item only with its exact green evidence.
- Verify a visual change in the running app and inspect the screenshots. Desktop has a sandboxed live app for this ([live-app verification](apps/desktop/AGENTS.md#live-app-verification)).
- After two identical tooling failures with no new evidence, change approach or report the blocker. Retrying blindly or bypassing a guard is not a fix.

## One owner, complete cutover

1. **Intent.** Reproduce the defect, then read the affected module, its callers, siblings, tests, and history until the violated invariant is clear. Before restoring a removed path, find out why it was removed (`git log -p -S <symbol>`).
2. **Owner.** Change the code that owns the decision or the state. A new owner needs a responsibility that nothing else covers.
3. **Cutover.** Migrate every caller in the same change, and delete what the change replaces: old code, wrappers, exports, registrations, tests, and docs. Keep a compatibility path only when persisted data or a shipped format needs it, and name that contract in a comment.
4. **Proof.** Exercise the user flow and its siblings, and confirm the retired paths are unreachable.

- Prefer smaller, simpler production code, and explain any growth. Record unrelated problems as follow-ups.
- Ask before removing functionality or code that looks intentional and that your change did not replace.

## Compatibility

This is production, and compatibility with existing installs is mandatory. Every change works on existing data without a database reset. Before changing a schema, contract, or format, state the migration and the compat plan.

These cross versions and must accept data written by older and newer builds:

- Vault files on disk, including frontmatter and the `.memry/` folder.
- The local SQLite databases. Migrations are hand-written and additive ([desktop databases](apps/desktop/AGENTS.md#databases)).
- The sync protocol and its payloads, specified in `docs/protocol/` and implemented by desktop, the Rust core, and the sync server. The protocol has no negotiated version. Skew is handled only by the client header's version floor (chapter 11) and per-format version bytes (§0.2), so build on those.
- The D1 schema, which is forward-only and additive ([sync server](apps/sync-server/AGENTS.md#compatibility)).
- Settings shapes, local and synced.
- Interfaces other programs call, such as the extension's loopback capture API, the Agent MCP tools, deep links, and the CLI's commands, flags, and output.

Renderer and main ship in one build, so an IPC contract change updates both sides in one change, with no shim.

## Code

- Use real types or `unknown`. Use `any` only when no type can express the value, and say why in a comment. Read external API types in `node_modules` instead of guessing.
- Imports go at the top of the file, type imports included, never `import("pkg").Type`. The exception is a module that must load lazily because of import-time side effects or startup cost. Load it with `await import()` and a comment saying why.
- Inline a one-line helper that has a single call site.
- When an outdated dependency causes type errors, upgrade the dependency and keep the code.
- Zod v4 throws in `safeParse` on `z.record(z.unknown())`. Write `z.record(z.string(), z.unknown())`.
- Give every failure a visible outcome: an error the user can act on, or a log entry with context. Empty catch blocks and silent fallbacks hide data loss.
- New UI uses logical layout properties on every platform, so RTL works: Tailwind `ms-*`/`me-*`, `ps-*`/`pe-*`, `start-*`/`end-*`, `text-start`/`text-end`, `border-s`/`border-e`, `rounded-s-*`/`rounded-e-*`, and SwiftUI `leading`/`trailing`.
- ESLint caps desktop TypeScript files at 800 lines. `scripts/check-line-ceilings.mjs` caps Rust sources at 600 and iOS feature files at 400. Split a file at its ceiling before adding behavior to it.
- Regenerate generated outputs, never hand-edit them. These pairs move together in one change:
  - `packages/contracts`, preload APIs, or main IPC handlers: run `pnpm ipc:generate`, then `pnpm ipc:check`.
  - A format covered by conformance vectors: update the `docs/protocol/` chapter and regenerate that vector class ([crates guide](crates/AGENTS.md#conformance)).
  - The UniFFI API of `crates/memry-core`: run `crates/memry-core/build-xcframework.sh` and commit the regenerated Swift bindings. CI rebuilds them and fails on any difference.
  - `packages/article-extract/src`: run `node scripts/generate-ios-article-extract.mjs` and commit the regenerated `apps/ios/Memry/Resources/article-extract.js`.

## Dependencies

- Dependency and lockfile changes are reviewed code. Reach for the standard library, then a platform feature, then an installed dependency, then new code. Add a dependency last, and never for what a few lines do.
- Hydrate with `pnpm install`. CI uses `pnpm install --frozen-lockfile`.

## Validation

After code changes, run these with full output and fix every error before committing. A docs-only change needs `git diff --check` and its docs build.

```bash
pnpm lint         # ESLint over apps/desktop
pnpm typecheck    # shared packages, cli, desktop, sync-server; desktop's pretypecheck adds check:contracts, check:architecture, ipc:check
git diff --check
```

- `pnpm lint` and `pnpm typecheck` skip landing, extension, marketing-emails, iOS, and Rust. Their scoped guides name their gates.
- A package with its own `test` script runs its tests there. The other shared packages run under desktop's `shared` Vitest project (`pnpm --filter @memry/desktop test:shared`).
- Shared code has no app-only changes. A change in `packages/` keeps every consumer green, including desktop, the CLI, and the sync server.
- A failing test is a defect until proven otherwise. Fix the owner and keep a regression test. Skipping, loosening, or deleting a test to get green needs Kaan's approval.
- Tests protect user-visible behavior and contracts, not implementation details. Test the seam that can lose data through the real adapter. A mocked boundary supplements that test and is never evidence that the boundary works. A bug fix ships with a test that fails without the fix.
- Pre-commit runs lint-staged and the whitespace, staged-secret, and renderer guard checks, plus `check:lockfile` and `ipc:check` when their inputs change. Pre-push checks the branch name and the [docs gate](apps/docs/AGENTS.md#docs-gate). CI owns lint, typecheck, and tests, so they stay out of pre-push unless Kaan asks.

## Authority and safety

- Ask before each of these, every time: deploys, releases, store submissions, sending email, pushing to `main`, resetting or deleting staging data, and deleting branches, worktrees, or data you did not create. An approval covers the action it named.
- A push to `main` deploys. Docs and landing go to Vercel production. Changes to the sync server or the packages it bundles deploy to staging, after their D1 migrations apply to the remote staging database. Production sync-server deploys run only by manual dispatch. The extension publishes from an `extension-v*` tag, and desktop releases run through `pnpm release`.
- Production data is read-only for agents.
- Keep secrets and user data out of commits, logs, transcripts, screenshots, and chat. Env files are gitignored and linked across worktrees by `pnpm env:link`. Read a value only when the task needs it, and never print it.
- Commit only when Kaan asks.

## Git

Multiple agent sessions may work in this checkout at once, each changing different files. Git commands that touch files outside your change destroy their work.

- Commit only files you changed in this session. Stage explicit paths (`git add <path>...`), and check `git status` before committing.
- Message format is `type(scope): message`. Types are `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore`, and `ci`. The scope names the app or area (`desktop`, `sync-server`, `ios`, `core`, `sync`, `cli`, `extension`, `landing`, `docs`, `emails`), comma-joined when a change spans several. Keep the message informative and concise, with no @mentions, `fixes #...` keywords, or `Co-authored-by:` trailers.
- Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, or `git commit --no-verify`.
- On a rebase conflict, resolve only files you modified. For a conflict in any other file, abort and ask. Never force push.
- Name a branch for its change, such as `fix/folder-view-load-all-pages`. Rename a tool-branded or random name (`codex/`, `claude/`, `cursor/`, `t3code`) before pushing, since pre-push rejects them.

## Read when relevant

Read the matching guide in full before starting. Commands and details live there.

- Desktop app, local databases, IPC, native modules, and the shared TypeScript packages: [apps/desktop/AGENTS.md](apps/desktop/AGENTS.md).
- iOS app: [apps/ios/AGENTS.md](apps/ios/AGENTS.md).
- Rust core, UniFFI bindings, and conformance vectors: [crates/AGENTS.md](crates/AGENTS.md).
- Sync server, D1, and R2: [apps/sync-server/AGENTS.md](apps/sync-server/AGENTS.md).
- Sync wire format: `docs/protocol/`. Every normative sentence cites `path:line`, and `packages/contracts` wins a disagreement until the chapter is amended.
- CLI: [apps/cli/AGENTS.md](apps/cli/AGENTS.md).
- Browser extension: [apps/extension/AGENTS.md](apps/extension/AGENTS.md).
- Docs site and the docs gate: [apps/docs/AGENTS.md](apps/docs/AGENTS.md).
- Landing site: [apps/landing/AGENTS.md](apps/landing/AGENTS.md).
- Marketing emails: [apps/marketing-emails/AGENTS.md](apps/marketing-emails/AGENTS.md).
- UI work in any app: [PRODUCT.md](PRODUCT.md) and [DESIGN.md](DESIGN.md). Product apps share the product register. `apps/landing` is the brand register, and neither borrows the other's typography, mascots, or CTA treatment. WCAG AA, reduced motion, and RTL apply everywhere.
- Test suites, known gotchas, and desktop releases: `apps/docs/src/contribute/` (`testing.md`, `gotchas.md`, `releasing.md`).
- Library, framework, SDK, or CLI documentation: [docs/agents/context7.md](docs/agents/context7.md).
- Opening a PR: [docs/agents/contributing.md](docs/agents/contributing.md).

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `memrynote/memry` (via `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.
