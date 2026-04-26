# CLAUDE.md

Research the codebase before editing. Never change code you haven't read."

## Build & Dev

```bash
pnpm dev                                      # legacy Electron desktop app
pnpm --filter @memry/desktop-tauri dev       # Tauri migration app
```

## Verify

```bash
pnpm lint         # ESLint (flat config)
pnpm typecheck    # TypeScript across all packages
pnpm test         # Vitest (desktop + sync-server via turbo)
pnpm test:e2e     # Playwright E2E (Electron)
pnpm ipc:check    # validate IPC contract types (renderer↔main boundary)
pnpm ipc:generate # regenerate IPC invoke map from contracts
pnpm --filter @memry/desktop-tauri cargo:test     # Rust tests for Tauri backend
pnpm --filter @memry/desktop-tauri bindings:check # validate generated Tauri bindings
```

## Approach
- Think before acting. Read existing files before writing code.
- Be concise in output but thorough in reasoning.
- Prefer editing over rewriting whole files.
- Do not re-read files you have already read unless the file may have changed.
- Test your code before declaring done.
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

## Database

```bash
pnpm db:generate  # Drizzle schema → migration SQL
pnpm db:push      # apply migrations
pnpm db:studio    # Drizzle Studio GUI
```

Dual-database pattern: data DB (notes, tasks, projects) + index DB (search, graph). Both use better-sqlite3 via Drizzle ORM.

## Monorepo Structure

- `apps/desktop` — Electron 39 + React 19 + Vite (main/renderer/preload). **FROZEN** during Tauri migration (see `apps/desktop/README.md` + `.github/workflows/electron-freeze.yml`). All new work goes to `apps/desktop-tauri/`.
- `apps/desktop-tauri` — Tauri 2.x + Vite 7 + React 19 + Tailwind v4 + Rust 1.95. Target of the Electron → Tauri migration. M1 ships a full renderer port backed by mock IPC; M2+ activates real Rust commands. See `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md`.
- `apps/sync-server` — Cloudflare Workers + Hono (D1 + R2)
- `packages/contracts` — IPC and API type definitions (Zod validation)
- `packages/db-schema` — Drizzle ORM schemas (data + index)
- `packages/shared` — Minimal shared utilities

## Code Style

Prettier: single quotes, no semicolons, 100 char width, no trailing commas.

- **Logging**: Always `createLogger('Scope')` from `electron-log`, never raw `console.*`
- **User-facing errors**: Always `extractErrorMessage(err, fallback)` from `@/lib/ipc-error`
- **IPC boundary**: All renderer↔main communication goes through `packages/contracts`. Run `pnpm ipc:check` after editing contract types.

## Architecture

- **Pre-production**: No backward-compat constraints. DB schema and code can be reset anytime.
- **E2E encrypted**: XChaCha20-Poly1305 + Ed25519 + Argon2id via libsodium. Server never sees plaintext.
- **Offline-first**: SQLite local storage, CRDT sync (Yjs) for notes/journals, field-level vector clocks for tasks/projects.
- **Sync items**: Metadata in D1, encrypted payloads in R2 (avoids D1 1MB row limit).
- **CRDT ownership**: Main process owns Y.Docs; renderer uses IPC provider. Tag updates with `sourceWindowId` to prevent IPC loops.
- **Sync handler pattern**: Per-type handlers in `src/main/sync/item-handlers/` via strategy pattern. Use `getHandler(type)` registry.

## Known Gotchas

- `better-sqlite3` ERR_DLOPEN_FAILED in tests = NODE_MODULE_VERSION mismatch → `pnpm rebuild better-sqlite3`
- Zod v4: `z.record(z.unknown())` throws in safeParse → use `z.record(z.string(), z.unknown())`
- Pre-existing type errors in test files (websocket.test.ts, folders.test.ts) — ignore during typecheck
- Lazy URL resolution in http-client (per-call, not module-level) to avoid import-time throws in tests
- Drizzle: nullable JSON columns need `null` not `undefined` in `.values()` insert
- **Submit buttons that disable themselves mid-click lose the click.** If `onClick` calls a handler that synchronously sets state which adds `disabled` to the button (e.g. `disabled={isSubmitting}`), the browser suppresses the `click` event at the DOM layer between `pointerdown` and `click`. Fire submit from `onPointerDown` (runs before the re-render applies `disabled`) and keep `onClick` as a keyboard-activation fallback. See `calendar-quick-create-dialog.tsx`.

## gstack

Use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.

Available skills:
/office-hours, /plan-ceo-review, /plan-eng-review, /plan-design-review, /design-consultation, /review, /ship, /land-and-deploy, /canary, /benchmark, /browse, /qa, /qa-only, /design-review, /setup-browser-cookies, /setup-deploy, /retro, /investigate, /document-release, /codex, /cso, /autoplan, /careful, /freeze, /guard, /unfreeze, /gstack-upgrade

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

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
