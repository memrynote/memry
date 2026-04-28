# Task 00: Create worktree for Phase A

> **Plan:** `docs/superpowers/plans/2026-04-29-i18n-phase-a-infrastructure.md` (Worktree Setup)
> **Spec:** `docs/superpowers/specs/2026-04-29-i18n-multi-language-support-design.md`
> **Depends on:** Clean state on `main` branch
> **Dependents:** All subsequent Phase A tasks

## Pre-flight check

```bash
cd /Users/h4yfans/sideproject/memry
git status                         # must be clean
git rev-parse --abbrev-ref HEAD    # should be main
```

If working tree is dirty, abort and report — don't proceed with uncommitted changes.

## Your job

Create a git worktree at `../memry-i18n-phase-a` on a fresh branch `feature/i18n-phase-a`. All subsequent Phase A tasks run inside this worktree per memry's MEMORY.md preference (worktree-isolated implementation).

## Steps

1. Create the worktree:

```bash
git worktree add ../memry-i18n-phase-a -b feature/i18n-phase-a
```

2. Switch into the worktree:

```bash
cd ../memry-i18n-phase-a
```

3. Install dependencies in the worktree:

```bash
pnpm install
```

4. Verify clean state:

```bash
git status                         # must be clean
git log --oneline -3               # should match main's recent commits
```

## Exit criteria

- [ ] Worktree exists at `../memry-i18n-phase-a`
- [ ] Branch `feature/i18n-phase-a` exists and is checked out in the worktree
- [ ] `pnpm install` succeeded; no native rebuild errors
- [ ] Working tree is clean

## Skills to use

None for this task — pure setup.

## Report back

```
✅ Task 00 complete.
Worktree: ../memry-i18n-phase-a
Branch: feature/i18n-phase-a
pnpm install: success
Next: Task 0a (preflight Intl.Locale.textInfo)
```
