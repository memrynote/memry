# Repo Workflow

Branches, commits, atomic changes, and shipping.

## Branches

Branch off `main`:

```bash
git checkout -b feat/your-feature main
```

## Commits

- Conventional Commits format (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`, `ci:`, `perf:`).
- One logical change per commit.
- Use the atomic-commit skill (`/atomic-commit`) when staging multi-purpose diffs.

## Pull Requests

- Title under 70 characters.
- Body covers Summary and Test plan as a bulleted checklist.
- Run focused checks before pushing.

## Pre-Land Checks

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm ipc:check   # if you touched the renderer/main boundary
```

## Shipping

`/ship` and `/merge` skills wrap the standard PR + CI + merge flow. They generate changelog entries and atomic commits as needed.

## CHANGELOG

Always update root `CHANGELOG.md` during a merge. Release Drafter handles ongoing aggregation per label.
