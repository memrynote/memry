# GOAL: Implement Agent Chat (P1 → P2 → P3) for memry

You are implementing the "Agent Chat" feature in the memry desktop app. Three phases, each its own PR series — do not bundle phases. Work in `/Users/h4yfans/sideproject/memry`.

## Required reading (in order, before writing any code)

1. `CLAUDE.md` — repo conventions

2. `docs/superpowers/specs/2026-05-10-agent-chat-design.md` — the design spec (source of truth)

3. `docs/superpowers/plans/2026-05-10-agent-chat-p1-vault-mcp.md` — Phase 1 task list (start here)

4. `docs/superpowers/plans/2026-05-10-agent-chat-p2-conversation-storage.md` — Phase 2

5. `docs/superpowers/plans/2026-05-10-agent-chat-p3-chat-ui.md` — Phase 3

The plans are written task-by-task with bite-sized TDD steps. Execute them as written. Do not invent new approaches or skip steps. If a task says "write the failing test", write it first and run it before any implementation.

## Execution discipline

- **Branching:** `feat/agent-chat-p1-vault-mcp`, then `feat/agent-chat-p2-conversation-storage`, then `feat/agent-chat-p3-chat-ui`. P2 starts from `main` after P1 merges. P3 starts from `main` after P2 merges. Never combine phases on one branch.

- **TDD per task:** failing test → run → minimal implementation → run → commit. Commit message format: `feat(<scope>): <task summary>` matching the conventional-commits convention used in plan steps.

- **Commit per task, not per phase.** Granular history is required.

- **Never use `--no-verify`, `--no-gpg-sign`, or any hook bypass.** If a hook fails, fix the underlying issue.

- **Never amend a previous commit.** Always create a new commit. If a pre-commit hook fails, the commit did not happen — fix and re-commit.

- **Read before writing.** Don't change code you haven't read. Re-use existing patterns; don't refactor adjacent code.

## Verification gates (run before declaring a task complete)

Per-task: the test added in that task must pass, plus any tests that previously passed must still pass.

Per phase before opening a PR:

pnpm lint
pnpm typecheck:node
pnpm typecheck:web
pnpm --filter @memry/desktop test
pnpm test:e2e -- agent # only after building
pnpm docs:impact --strict
pnpm docs:build

Pre-existing failures that should be ignored (do not "fix" them — they are documented in `CLAUDE.md` as Known Gotchas):

- Type errors in `apps/desktop/src/main/sync/sync-telemetry.ts`

- Type errors in `apps/desktop/tests/**/websocket.test.ts`, `**/folders.test.ts`

- Other pre-existing test-file errors flagged by `pnpm typecheck`

## E2E build discipline (this is the #1 source of confusion)

E2E launches `apps/desktop/out/main/index.js`, NOT source. Before EVERY E2E run after editing source:

bash apps/desktop/scripts/ensure-native.sh electron # rebuild better-sqlite3 for Electron ABI
pnpm --filter @memry/desktop exec electron-vite build # rebuild bundle
pnpm --filter @memry/desktop test:e2e -- <pattern>

If a Node-side test errors with `ERR_DLOPEN_FAILED` or NODE_MODULE_VERSION mismatch:

- For Vitest tests: `pnpm rebuild better-sqlite3`

- For Electron / E2E: `bash apps/desktop/scripts/ensure-native.sh electron`

## Project-specific rules (never violate)

- **Migrations are hand-written since 0020.** Do NOT run `pnpm db:generate` for the agent chat migration; write the SQL by hand and append a journal entry to `apps/desktop/src/main/database/drizzle-data/meta/_journal.json` (the P2 plan shows the exact format).

- **IPC contracts:** after editing files in `packages/contracts/src/`, run `pnpm ipc:generate` then `pnpm ipc:check`. Commit the generated map.

- **Logging:** always `createLogger('Scope')` from `electron-log`, never raw `console.*`.

- **User-facing errors:** always `extractErrorMessage(err, 'fallback')` from `@/lib/ipc-error`.

- **Tailwind:** logical RTL-safe classes only (`ms-*`, `me-*`, `ps-*`, `pe-*`, `start-*`, `end-*`, `text-start`, `text-end`, `border-s/e`, `rounded-s/e-*`). Never `ml-*` / `mr-*` / `left-*` / `right-*` / `text-left` / `text-right` in new files.

- **No backward-compat code.** This is pre-production; if a schema or API changes, just change it.

- **No silent fallback to training-data answers.** When a CLI flag, library API, or stream-event shape is uncertain, run `claude --help` / inspect the official MCP SDK source / check the actual Claude CLI version locally before guessing.

## When you discover the plan is wrong or under-specified

The plans were written from a codebase audit, but some details (existing function names like `addTagToNote`, `listTasksForAgent`, etc.) may differ from what's actually in the repo. The plans contain "Note for the implementer" blocks for these spots. Rule:

1. **Search the codebase first** (`grep` / `rg`) for the function or symbol the plan references.

2. **If it exists** under a different name, use the real name and continue.

3. **If it doesn't exist** but the equivalent logic lives inside an IPC handler, extract it into a small named function in the same file (no logic duplication; the IPC handler should call the new function).

4. **Never invent a wrapper that bypasses sync queueing or vector clocks.** All vault mutations must go through the same domain entry points renderer IPC uses, so existing field-clock / sync-queue bookkeeping fires.

## Out of scope (do NOT touch)

- Codex CLI backend (P4) — not in this work

- Cloud Anthropic / OpenAI / Ollama backends (P5) — not in this work

- Plan-first / autonomous mode — later

- RAG / embeddings — later

- Project / folder write tools — explicitly excluded from v1 tool surface

- Delete / archive tools — explicitly excluded from v1 tool surface

- Mobile chat — no mobile app exists yet

If the spec, the plan, and the existing code disagree, follow this order: existing code (for shapes/signatures it has today), then spec (for behavior), then plan (for task ordering). Surface any genuine contradiction in the PR description rather than picking silently.

## Acceptance criteria per phase

**P1 ships when:**

- All 19 vault tools registered in the MCP server (10 read + 4 create + 5 update)

- Bearer-token auth, 401 on bad/missing token, token in-memory only

- `vault_get_current_note` snapshots active note from named window or returns null for external clients

- All write tools return `PERMISSION_DENIED` until P3 supplies a gate (a P1 unit test asserts this)

- Settings panel shows URL + token with copy and rotate

- External Cursor/Claude Desktop config can hit `tools/list` and read tools (E2E asserts)

- Server starts on app boot, stops on `before-quit`

- All P1 tests, lint, typecheck, docs all green

**P2 ships when:**

- `vault_metadata` singleton exists; UUID stable across restarts

- `agent_conversations` and `agent_messages` tables exist; migration 0029 applied cleanly

- Title and message bodies encrypted at rest with purpose-bound AD; forensic test (no plaintext on disk) passes

- `AgentConversationHandler` field-merges title / pinned / trust list independently

- `AgentMessageHandler` is append-only and idempotent on duplicate ids

- Both handlers registered in `apps/desktop/src/main/sync/item-handlers/index.ts`

- Entitlement gate skips enqueue for free users; backfill helper drains on upgrade

- Streaming messages cannot be enqueued (only terminal status flows through)

- All P2 tests, lint, typecheck, docs all green

**P3 ships when:**

- Day | Agent right-sidebar tab works; activity dot fires when chat is in background

- First-time provider disclosure required; subprocess never starts before user accepts

- Claude binary detection + version pin; install hint shown when missing/old

- Conversation create / list / load / switch via dropdown

- Composer with `@` ref picker, attached chips, current-note auto-attach, Cmd/Ctrl+Enter submit, Enter newline

- Streaming assistant text renders smoothly; tool-call cards appear inline

- Read tools auto-approved; create tools through approval modal; update tools through diff/before-after modal

- Allow-always grows trust list; trust list is per-conversation only; never persists cross-conversation

- Stop / Esc cancels a running turn; subprocess SIGTERM → SIGKILL after 500 ms

- Subprocess cleanup on app quit confirmed (no orphan `claude` processes)

- Conversation compaction triggers above 100k tokens; oldest 50% summarized into a system note

- Per-conversation turn lock blocks concurrent sends from a second window with a clear error

- E2E test passes: create task from current note end-to-end (uses stub `claude` binary fixture)

- All P3 tests, lint, typecheck, docs all green

## PR per phase

After all tasks in a phase are committed and the verification gate is green:

gh pr create --title "feat: agent chat <phase> — <short description>" --body "$(cat <<'EOF'

## Summary

- Implements <phase> of the Agent Chat feature
- Reference: docs/superpowers/specs/2026-05-10-agent-chat-design.md
- Plan: docs/superpowers/plans/2026-05-10-agent-chat-<phase>-\*.md

## Acceptance

<copy the deliverable checklist from the bottom of the plan, with all boxes checked>

## Test plan

- [ ] pnpm lint
- [ ] pnpm typecheck:node && pnpm typecheck:web
- [ ] pnpm --filter @memry/desktop test
- [ ] pnpm test:e2e -- agent
- [ ] pnpm docs:impact --strict && pnpm docs:build
- [ ] Manual smoke (see plan's "Manual verification" steps)
      EOF
      )"

Stop after each phase's PR is opened. Do NOT auto-merge. Wait for review.

## Proceed

**Proceed without asking** when:

- The plan task is clear and the codebase matches what it expects.

- A "Note for the implementer" block in the plan tells you to extract a small helper from an existing IPC handler — do it.

- A pre-existing failure in test files matches the documented Known Gotchas.

## Now begin

Start with Phase 1, Task 1 of `docs/superpowers/plans/2026-05-10-agent-chat-p1-vault-mcp.md`. Work the plan top-to-bottom. Commit after every task. Open the P1 PR when its acceptance criteria are met. Then start Phase 2, then Phase 3. Make sure feature is running from start to end.
