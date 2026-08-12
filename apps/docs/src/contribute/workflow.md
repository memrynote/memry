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

Use `gh pr create` to keep formatting clean. PR CI enforces:

- Lint + typecheck CI gate
- Tests (vitest) gate
- IPC contract check gate
- Visual review for renderer changes

Full E2E (Playwright) runs on `main` pushes.

## Docs Updates

Desktop, sync-server, contract, sync protocol, and schema changes go through a docs-impact gate. Before pushing or opening a PR, run:

```bash
pnpm docs:ai-update
pnpm docs:impact --strict
pnpm docs:build
```

`docs:ai-update` uses the Codex CLI to inspect the branch diff and update only `apps/docs/src`. The pre-push hook only runs the docs impact check; when docs are missing, it stops the push and points you to the manual updater. Set `MEMRY_DOCS_AI_AUTO=1` only when you want the hook to run the updater for that push. Lint, typecheck, and test suites run in GitHub Actions.

If a change truly has no docs impact, set `MEMRY_DOCS_IMPACT_SKIP=1` — `MEMRY_DOCS_IMPACT_SKIP=1 git push` for the hook, or `MEMRY_DOCS_IMPACT_SKIP=1 pnpm docs:impact --strict` for a manual run. The gate then reports the waived files and passes; say why the change needs no docs in the PR. There is no CI-side docs gate and no `docs:not-needed` label — the check is local only.

## Pre-Land Checks

Before opening a PR, make sure docs are current:

```bash
pnpm docs:impact --strict
pnpm docs:build
```

GitHub Actions run lint, typecheck, and test suites. For faster local feedback before pushing, run focused checks for the area you touched:

```bash
pnpm typecheck:node     # main process
pnpm typecheck:web      # renderer
pnpm --filter @memry/desktop typecheck:test   # test files (see Testing)
pnpm --filter @memry/desktop test
```

These skip the flaky `ipc:check` pre-hook and the pre-existing `sync-telemetry.ts` typecheck error.

## Shipping

The `/ship` and `/merge` skills wrap the standard PR + CI + merge flow:

- `/ship` — push, open PR, wait for CI, present a summary
- `/merge` — final landing pass: atomic commits, verify, push, wait for CI green, merge to `main`

Desktop releases use `pnpm release -- --humanize`. After the GitHub release is published, run
`pnpm release:reddit -- --tag <tag>` to print a copy/paste-ready Reddit title and body for
`r/MemryNote`.

## Don'ts

- Use `--no-verify` only for urgent bypasses after focused checks pass
- Never `--amend` after a hook failure (creates a new commit instead)
- Never `git add -A` or `git add .` (stage explicit paths)
- Never commit `.env` or anything that looks like a secret
- Never push to `main` directly; always go through a PR

## Worktrees for Plan Execution

When working through a multi-step plan, use a git worktree (or the EnterWorktree tool) to keep your current branch clean and reviewable.

## See Also

- [Testing](/contribute/testing)
- [Common Gotchas](/contribute/gotchas)
