# Development Rules

This file backs `AGENTS.md`; `AGENTS.md` is a symlink to `CLAUDE.md`.

Kaan owns this repo. Each app under `apps/` has its own `AGENTS.md` with rules for that surface; read it before touching that app. This file holds repo-wide rules.

## Conversational Style

- Keep answers short and concise. Technical prose only, be direct.
- No emojis in commits, issues, PR comments, or code.
- No fluff, no cheerful filler, no sycophantic openers or closing fluff.
- Explain non-trivial designs as: problem, concrete example or short trace, then solution. State why the solution is necessary and separate it from optional complexity.
- Prefer concrete behavior over abstract summaries or unexplained lists of changes.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to feedback or an analysis, say explicitly whether you agree or disagree before saying what you changed.
- State assumptions. If multiple interpretations exist, surface them. If unsure, say so; never guess or invent file paths.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- Do not re-read files you have already read unless they may have changed.
- Prefer editing over rewriting whole files. One focused pass; no write-delete-rewrite cycles.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check `node_modules` for external API types; don't guess.
- No inline imports (`await import()`, `import("pkg").Type`). Top-level imports only, except where a module must stay lazy to avoid import-time side effects — say why in a comment.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Always ask before removing functionality or code that appears intentional.
- Logging: always `createLogger('Scope')` from `electron-log` in desktop/main code, never raw `console.*`.
- User-facing errors: always `extractErrorMessage(err, fallback)` from `@/lib/ipc-error`.
- Tailwind logical properties (RTL safety): new code uses `ms-*`/`me-*`, `ps-*`/`pe-*`, `start-*`/`end-*`, `text-start`/`text-end`, `border-s`/`border-e`, `rounded-s-*`/`rounded-e-*`. Physical equivalents are rejected in new code; pre-existing files are exempt.

## Backward Compatibility

This is PRODUCTION. Real users run this app on real data. Backward compatibility is MANDATORY, and unlike upstream defaults it is never optional here.

- Every change must work for existing installs. No DB resets.
- DB schema changes go through additive, hand-written migrations that preserve existing rows. Data DB migrations are hand-written; Drizzle snapshots are broken past 0021.
- Sync protocol, IPC contracts, vault file formats, and settings shapes must tolerate data written by older app versions.
- Before any schema, contract, or format change, state the migration and compat plan.

## Architecture

- E2E encrypted: XChaCha20-Poly1305 + Ed25519 + Argon2id via libsodium. Server never sees plaintext.
- Offline-first: SQLite local storage, CRDT sync (Yjs) for notes/journals, field-level vector clocks for tasks/projects.
- Sync items: metadata in D1, encrypted payloads in R2 (avoids the D1 1MB row limit).
- CRDT ownership: main process owns Y.Docs; renderer uses an IPC provider. Tag updates with `sourceWindowId` to prevent IPC loops.
- Sync handlers: per-type handlers in `apps/desktop/src/main/sync/item-handlers/` via strategy pattern. Use the `getHandler(type)` registry.
- Domain docs: root `CONTEXT-MAP.md` points at per-app and per-package `CONTEXT.md`; ADRs live at the root and per context. See `docs/agents/domain.md`.

## Commands

Repo-wide verification:

```bash
pnpm lint                 # ESLint (flat config)
pnpm typecheck            # TypeScript across all packages
pnpm test                 # Vitest (desktop + sync-server via turbo)
pnpm check:architecture   # architecture boundary check
pnpm check:contracts      # contract boundary check
git diff --check
```

Rules:

- After code changes (not docs), run `pnpm lint` and `pnpm typecheck` with full output. Fix all errors before committing.
- Run the narrowest test command that covers your change; see the app's `AGENTS.md` for its focused commands.
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- Test once, fix if needed, verify once. No unnecessary iterations.
- For ad-hoc scripts, write them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never commit unless the user asks.

## Database

```bash
pnpm --filter @memry/desktop db:generate     # Drizzle schema -> migration SQL
pnpm --filter @memry/desktop db:push         # apply migrations
pnpm --filter @memry/desktop db:studio:data
pnpm --filter @memry/desktop db:studio:index
```

Dual-database pattern: data DB (notes, tasks, projects) + index DB (search, graph). Both use better-sqlite3 via Drizzle ORM.

## IPC Contracts

All renderer<->main communication goes through `packages/contracts`.

```bash
pnpm ipc:generate   # regenerate the IPC invoke map from contracts
pnpm ipc:check      # validate IPC contract types
```

Run `ipc:generate` before `ipc:check` when editing contracts, preload APIs, main IPC handlers, generated RPC bindings, or Agent Chat provider/IPC channels.

## Native Modules

- Node-side tests or scripts failing to load `better-sqlite3` / `classic-level` / `keytar`: `pnpm --filter @memry/desktop rebuild:node`.
- Electron dev/E2E/build native load errors: `pnpm --filter @memry/desktop rebuild:electron`.
- Do not use the Node rebuild as proof for Electron runtime, or the Electron rebuild as proof for Node tests.
- Fresh worktrees may spend a long quiet period rebuilding Electron native deps; do not call that a hang without evidence. `pnpm install` kicks the rebuild off detached (`scripts/warm-native.mjs`). Watch it with `pnpm warm:log`, run it foreground with `pnpm warm`. `SKIP_ELECTRON_REBUILD=1` (CI) skips it.

## Docs

- `scripts/docs-impact.mjs` is the docs-routing source of truth.
- Pre-push is intentionally docs-only for code-relevant changes: branch-name guard, base commit resolution, `pnpm docs:impact --base "$base_commit" --strict`, and `pnpm docs:ai-update --base "$base_commit"` only when `MEMRY_DOCS_AI_AUTO=1`. Do not re-add local lint/typecheck/test/docs-build to regular pre-push unless Kaan explicitly asks.
- Before push, PR, or merge after desktop/sync-server changes, run `pnpm docs:ai-update --base <base_commit>` or update `apps/docs/src` by hand, then `pnpm docs:impact --base <base_commit> --strict` and `pnpm docs:build`.
- If docs impact says `missing-docs`, update only real docs under `apps/docs/src/**`.
- Use `MEMRY_DOCS_IMPACT_SKIP=1` only when the change is intentionally non-docs and you can explain why.

## Dependencies

- Treat dep and lockfile changes as reviewed code. Never add a dependency for what a few lines can do.
- Hydrate locally with `pnpm install`; CI-style with `pnpm install --frozen-lockfile`.
- Prefer stdlib, then the native platform feature, then a dependency that is already installed, then new code. Only then a new dependency.

## Git

Multiple agent sessions may run in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work.

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- Message format: `{feat,fix,docs,chore}[(desktop,sync-server,landing,extension,cli,ios,docs,emails)]: <message>`. Informative and concise.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

Branches:

- Branch names must be code-context names. No `codex/`, `t3code`, `claude/`, `cursor/`, or random names like `fox-inline-go`.
- If a generated worktree/branch name is random, rename it before pushing.

## Contributor Guidelines
-  Keep changes focused and reviewable
-  add or update relevant tests
- When creating or submitting a pull request, disclose whether AI was used and briefly describe how
- Remind the human author that they are responsible for all submitted changes and refer them to CONTRIBUTING.md
- Do not put @mentions or fixes #... keywords in commit messages
- Do not add Co-authored-by: in commit messages

## Design

- Strategic brief: `PRODUCT.md`. Global product design authority: `DESIGN.md`. Read both before UI work.
- Register: `product` for desktop, mobile, and future product apps; `apps/landing` is a separate `brand` surface.
- Personality: calm, private, crafted. Not cold-corporate, not gamified, not cluttered.
- Principles: privacy is the product, one calm place, graceful by toggle, crafted not corporate, earn trust through restraint.
- A11y: WCAG AA, reduced-motion, RTL. Logical properties on every platform.
- Do not copy landing typography, mascots, or CTA treatment into product apps.

## Known Gotchas

- `better-sqlite3` ERR_DLOPEN_FAILED in tests = NODE_MODULE_VERSION mismatch -> `pnpm --filter @memry/desktop rebuild:node`.
- Zod v4: `z.record(z.unknown())` throws in safeParse -> use `z.record(z.string(), z.unknown())`.
- Drizzle: nullable JSON columns need `null`, not `undefined`, in `.values()` inserts.
- Lazy URL resolution in http-client is per-call, not module-level, to avoid import-time throws in tests. Keep it that way.
- Submit buttons that disable themselves mid-click lose the click. If `onClick` calls a handler that synchronously sets state adding `disabled` to the button, the browser suppresses the `click` event between `pointerdown` and `click`. Fire submit from `onPointerDown` and keep `onClick` as the keyboard fallback. See `calendar-quick-create-dialog.tsx`.
- Do not check off phase or checklist work unless the exact verification evidence is green.

## Context7

Use `ctx7` for current documentation when the user asks about a library, framework, SDK, API, CLI tool, or cloud service.

```bash
npx ctx7@latest library <Official Name> "<question>"
npx ctx7@latest docs /org/project "<question>"
```

Call `library` first unless the user gives a `/org/project` ID. Do not use ctx7 for refactoring, writing scripts from scratch, debugging business logic, code review, or general programming concepts.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
