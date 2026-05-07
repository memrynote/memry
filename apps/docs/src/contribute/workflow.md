# Repo Workflow

Branches, commits, atomic changes, and shipping.

## Branching

Branch off `main`:

```bash
git checkout -b feat/your-feature main
```

Naming follows the commit type:

- `feat/<slug>` — new feature
- `fix/<slug>` — bug fix
- `refactor/<slug>` — non-behavioral change
- `docs/<slug>` — docs-only
- `chore/<slug>`, `ci/<slug>`, `test/<slug>` — meta

## Commits

[Conventional Commits](https://www.conventionalcommits.org/). Allowed types:

`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`

```
feat: add wiki-link autocomplete with stable note IDs

Wiki links resolve via stable IDs so renames don't break inbound links.
The autocomplete service searches the index DB by title and falls back to
fuzzy matching across recent notes.
```

One **logical** change per commit. Use the atomic-commit skill (`/atomic-commit`) when the working tree mixes concerns.

## Pull Requests

- Title under 70 characters; lowercase imperative is fine (`feat: add foo` not `feat: Adds foo.`).
- Body has **Summary** and **Test plan** as a checklist.
- Push with `-u` on the first push to set upstream.

Use `gh pr create` to keep formatting clean. The repo enforces:

- Lint + typecheck CI gate
- Tests (vitest) gate
- E2E (Playwright) gate
- IPC contract check gate
- Visual review for renderer changes

## Pre-Land Checks

Before opening a PR:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm ipc:check     # if you touched the renderer/main boundary
```

For desktop-only changes, focused checks are faster:

```bash
pnpm typecheck:node     # main process
pnpm typecheck:web      # renderer
pnpm --filter @memry/desktop test
```

These skip the flaky `ipc:check` pre-hook and the pre-existing `sync-telemetry.ts` typecheck error.

## Shipping

The `/ship` and `/merge` skills wrap the standard PR + CI + merge flow:

- `/ship` — push, open PR, wait for CI, present a summary
- `/merge` — final landing pass: changelog entry, atomic commits, verify, push, wait for CI green, merge to `main`

`/merge` updates the root `CHANGELOG.md` automatically. Always run it for any PR that ships user-visible changes.

## Release Drafter

The repo runs Release Drafter on `main`. PR labels feed into the draft release notes:

- `type: feat` → Features
- `type: fix` → Fixes
- `type: docs` → Documentation
- `type: chore` → Maintenance

Branch labels are narrowed to release-relevant changes only.

## Don'ts

- Never `--no-verify`
- Never `--amend` after a hook failure (creates a new commit instead)
- Never `git add -A` or `git add .` (stage explicit paths)
- Never commit `.env` or anything that looks like a secret
- Never push to `main` directly; always go through a PR

## Worktrees for Plan Execution

When working through a multi-step plan, use a git worktree (or the EnterWorktree tool) to keep your current branch clean and reviewable.

## See Also

- [Testing](/contribute/testing)
- [Common Gotchas](/contribute/gotchas)
- [Releasing](/contribute/releasing)
