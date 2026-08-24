# CLAUDE.md

This file backs `AGENTS.md`; `AGENTS.md` is a symlink to `CLAUDE.md`.

Kaan owns this. Start: say hi + one motivating line. Work style: telegraph; noun phrases ok; drop grammar; min tokens.

Research the codebase before editing. Never change code you haven't read.

## Build & Dev

```bash
pnpm dev          # Electron desktop app
pnpm dev:desktop  # desktop through turbo
pnpm dev:landing  # landing site
pnpm dev:sync-server # sync server
pnpm docs:dev     # docs site
pnpm --filter @memry/desktop dev:a # desktop profile/device A
pnpm --filter @memry/desktop dev:b # desktop profile/device B
pnpm --filter @memry/desktop dev:c # desktop profile/device C
```

## Verify

```bash
pnpm lint         # ESLint (flat config)
pnpm typecheck    # TypeScript across all packages
pnpm test         # Vitest (desktop + sync-server via turbo)
pnpm test:desktop # desktop tests only
pnpm test:sync-server # sync-server tests only
pnpm test:e2e     # Playwright E2E (Electron)
pnpm check:architecture # architecture boundary check
pnpm check:contracts # contract boundary check
pnpm docs:impact --base origin/main --strict # docs gate for desktop/sync changes
pnpm docs:build   # VitePress docs build
pnpm ipc:check    # validate IPC contract types (renderer↔main boundary)
pnpm ipc:generate # regenerate IPC invoke map from contracts
git diff --check
```

Focused checks:

```bash
pnpm --filter @memry/desktop typecheck:web
pnpm --filter @memry/desktop typecheck:node
pnpm --filter @memry/desktop typecheck:test
pnpm --filter @memry/desktop test:renderer
pnpm --filter @memry/desktop test:main
pnpm --filter @memry/desktop i18n:check
npx -y react-doctor@latest .
```

Run `pnpm ipc:generate` before `pnpm ipc:check` when editing contracts, preload APIs, main IPC handlers, generated RPC bindings, or Agent Chat provider/IPC channels.

## Docs Automation

- `scripts/docs-impact.mjs` is the docs-routing source of truth.
- Pre-push is intentionally docs-only for code-relevant changes: branch-name guard, base commit resolution, `pnpm docs:impact --base "$base_commit" --strict`, optional `pnpm docs:ai-update --base "$base_commit"` only when `MEMRY_DOCS_AI_AUTO=1`.
- Do not re-add local lint/typecheck/test/docs-build to regular pre-push unless Kaan explicitly asks.
- If docs impact says `missing-docs`, update only real docs under `apps/docs/src/**` or run `pnpm docs:ai-update --base <base_commit>`, then `pnpm docs:impact --base <base_commit> --strict` and `pnpm docs:build`.
- Use `MEMRY_DOCS_IMPACT_SKIP=1` only when the change is intentionally non-docs and you can explain why.

## Approach

- Think before acting. State assumptions; if multiple interpretations exist, surface them.
- Read existing files before writing code.
- Be concise in output but thorough in reasoning.
- Prefer editing over rewriting whole files.
- Do not re-read files you have already read unless the file may have changed.
- Test your code before declaring done.
- Before push, PR, or merge after desktop/sync-server changes, run `pnpm docs:ai-update --base <base_commit>` or update `apps/docs/src` manually, then run `pnpm docs:impact --base <base_commit> --strict` and `pnpm docs:build`.
- No sycophantic openers or closing fluff.
- Keep solutions simple and direct. No over-engineering.
- If unsure: say so. Never guess or invent file paths.
- User instructions always override this file.

## Efficiency

- Read before writing. Understand the problem before coding.
- No redundant file reads. Read each file once.
- One focused coding pass. Avoid write-delete-rewrite cycles.
- Test once, fix if needed, verify once. No unnecessary iterations.
- Budget: 50 tool calls maximum. Work efficiently.

## Git & PR

- Branch names must be code-context names. No `codex/`, `t3code`, `claude/`, `cursor/`, or random names like `fox-inline-go`.
- If a generated worktree/branch name is random, rename it before pushing.
- Do not mention Codex, Claude, T3Code, Cursor, or other agent/tool branding in PR descriptions.
- Draft PR is the safe default when the user asks to create/push a PR and does not specify ready vs draft.
- For Memry worktrees, prefer repo-local `.worktrees/<name>`: `git worktree add .worktrees/<name> -b <name> origin/main`, then `pnpm install --frozen-lockfile`.
- Gitignored env files (`apps/desktop/.env.staging`, `apps/sync-server/.dev.vars`, `apps/landing/.env.local`, ...) do not travel with a worktree. `pnpm install` links them from the main worktree via `scripts/link-env.mjs`; run `pnpm env:link` by hand if a tree predates that, `pnpm env:check` to verify, `pnpm env:link:copy` for real copies instead of symlinks. They stay gitignored at the new paths. Without them `resolveSyncServerUrl()` silently falls back to `http://localhost:8787` and `dev:staging` never reaches staging.
- Fresh worktrees may spend a long quiet period rebuilding Electron native deps; do not treat that as a hang without evidence.

## Database

```bash
pnpm --filter @memry/desktop db:generate  # Drizzle schema → migration SQL
pnpm --filter @memry/desktop db:push      # apply migrations
pnpm --filter @memry/desktop db:studio:data
pnpm --filter @memry/desktop db:studio:index
```

Dual-database pattern: data DB (notes, tasks, projects) + index DB (search, graph). Both use better-sqlite3 via Drizzle ORM.

## Code Style

- **Logging**: Always `createLogger('Scope')` from `electron-log`, never raw `console.*`
- **User-facing errors**: Always `extractErrorMessage(err, fallback)` from `@/lib/ipc-error`
- **IPC boundary**: All renderer↔main communication goes through `packages/contracts`. Run `pnpm ipc:check` after editing contract types.
- **Tailwind logical properties (RTL safety)**: New code uses logical classes that flip automatically in RTL. Reject `ml-*` / `mr-*` (use `ms-*` / `me-*`), `pl-*` / `pr-*` (use `ps-*` / `pe-*`), `left-*` / `right-*` (use `start-*` / `end-*`), `text-left` / `text-right` (use `text-start` / `text-end`), `border-l` / `border-r` (use `border-s` / `border-e`), `rounded-l-*` / `rounded-r-*` (use `rounded-s-*` / `rounded-e-*`). Pre-existing files using physical classes are exempt (codemod is a future enhancement).

## Architecture

- **PRODUCTION — backward compatibility is MANDATORY**: Real users run this app on real data. Every change MUST work for existing installs. No DB resets. DB schema changes go through additive, hand-written migrations that preserve existing rows (data DB migrations are hand-written; Drizzle snapshots broken past 0021). Sync protocol, IPC contracts, vault file formats, and settings shapes must tolerate data written by older app versions. Before any schema/contract/format change, state the migration + compat plan.
- **E2E encrypted**: XChaCha20-Poly1305 + Ed25519 + Argon2id via libsodium. Server never sees plaintext.
- **Offline-first**: SQLite local storage, CRDT sync (Yjs) for notes/journals, field-level vector clocks for tasks/projects.
- **Sync items**: Metadata in D1, encrypted payloads in R2 (avoids D1 1MB row limit).
- **CRDT ownership**: Main process owns Y.Docs; renderer uses IPC provider. Tag updates with `sourceWindowId` to prevent IPC loops.
- **Sync handler pattern**: Per-type handlers in `src/main/sync/item-handlers/` via strategy pattern. Use `getHandler(type)` registry.

## Agent Chat

- Start from `docs/superpowers/specs/2026-05-10-agent-chat-design.md` before changing Agent Chat architecture.
- Current direction is MCP-first: one localhost Vault MCP server in the main process, reused by Claude CLI, Codex CLI, and local/OpenAI-compatible backends.
- External MCP clients are read-only by default. Writes require an active Memry Agent conversation and approval UI.
- Codex is a first-class backend when Agent Chat provider work comes up; do not detour to OpenAI API unless requested.
- Provider/model/reasoning changes must persist as conversation settings, not one-shot composer state.

## Native Modules

- Node-side tests or scripts with `better-sqlite3` / `classic-level` / `keytar` load errors: run `pnpm --filter @memry/desktop rebuild:node`.
- Electron dev/E2E/build native load errors: run `pnpm --filter @memry/desktop rebuild:electron`.
- Do not use the Node rebuild as proof for Electron runtime, or the Electron rebuild as proof for Node tests.

## Known Gotchas

- `better-sqlite3` ERR_DLOPEN_FAILED in tests = NODE_MODULE_VERSION mismatch → `pnpm --filter @memry/desktop rebuild:node`
- Zod v4: `z.record(z.unknown())` throws in safeParse → use `z.record(z.string(), z.unknown())`
- Desktop test files are typechecked by `tsconfig.test.node.json` / `tsconfig.test.web.json` (run via `pnpm --filter @memry/desktop typecheck:test`, and by `pnpm typecheck`). Both carry an `exclude` backlog of 309 test files that already failed to compile when the gate landed. That list only ever shrinks: never add a file to it — a new or newly-touched test file must compile.
- Lazy URL resolution in http-client (per-call, not module-level) to avoid import-time throws in tests
- Drizzle: nullable JSON columns need `null` not `undefined` in `.values()` insert
- **Submit buttons that disable themselves mid-click lose the click.** If `onClick` calls a handler that synchronously sets state which adds `disabled` to the button (e.g. `disabled={isSubmitting}`), the browser suppresses the `click` event at the DOM layer between `pointerdown` and `click`. Fire submit from `onPointerDown` (runs before the re-render applies `disabled`) and keep `onClick` as a keyboard-activation fallback. See `calendar-quick-create-dialog.tsx`.
- Do not check off phase/checklist work unless the exact verification evidence is green.

## gstack

Use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.

Available skills:
/office-hours, /plan-ceo-review, /plan-eng-review, /plan-design-review, /design-consultation, /design-shotgun, /design-html, /review, /ship, /land-and-deploy, /canary, /benchmark, /browse, /connect-chrome, /qa, /qa-only, /design-review, /setup-browser-cookies, /setup-deploy, /setup-gbrain, /retro, /investigate, /document-release, /document-generate, /codex, /cso, /autoplan, /plan-devex-review, /devex-review, /careful, /freeze, /guard, /unfreeze, /gstack-upgrade, /learn, /health, /spec, /diagram, /scrape, /skillify, /pair-agent, /context-save, /context-restore, /make-pdf, /landing-report, /plan-tune, /benchmark-models, /sync-gbrain, /open-gstack-browser, /gstack, /ios-qa, /ios-fix, /ios-clean, /ios-sync, /ios-design-review

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.
Mention the skill name and why you are using it.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `memrynote/memry`, driven by the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, label strings unchanged: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context — root `CONTEXT-MAP.md` points at per-app/per-package `CONTEXT.md`; ADRs live at the root and per context. See `docs/agents/domain.md`.

## Context7

Use `ctx7` for current documentation whenever the user asks about a library, framework, SDK, API, CLI tool, or cloud service.

```bash
npx ctx7@latest library <Official Name> "<user's question>"
npx ctx7@latest docs /org/project "<user's question>"
```

Call `library` first unless the user gives a `/org/project` ID. Do not use ctx7 for refactoring, writing scripts from scratch, debugging business logic, code review, or general programming concepts. Max 3 ctx7 commands per question. If quota fails, tell the user to run `npx ctx7@latest login` or set `CONTEXT7_API_KEY`.

## Design Context

Strategic design brief lives in `PRODUCT.md` (root). Read it before UI work.

- **Register:** `product` (desktop app) by default; `apps/landing` is a co-equal `brand` surface.
- **Personality:** calm, private, crafted. Not cold-corporate, not gamified, not cluttered.
- **Principles:** privacy is the product · one calm place · graceful by toggle · crafted not corporate · earn trust through restraint.
- **A11y:** WCAG AA + reduced-motion + RTL (logical Tailwind props).
- **Visual system:** `docs/DESIGN_TOKENS.md`, `apps/landing/src/index.css` (terracotta `#ff671a` / paper / ink). Run
- **Mascot icons:** hand-drawn set in `apps/landing/public/mascots`. To create a new one in-style, follow `apps/landing/scripts/mascots/README.md`.