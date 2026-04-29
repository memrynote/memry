# Task 00: Create worktree for Phase B + smoke-test Phase A

> **Plan:** `docs/superpowers/plans/2026-04-29-i18n-phase-b-common-namespace.md` (Worktree Setup)
> **Spec:** `docs/superpowers/specs/2026-04-29-i18n-multi-language-support-design.md`
> **Depends on:** Phase A merged to `main`
> **Dependents:** All subsequent Phase B tasks

## Pre-flight check

```bash
cd /Users/h4yfans/sideproject/memry
git status                         # must be clean
git rev-parse --abbrev-ref HEAD    # should be main
git log --oneline -5 | grep -i "i18n.*phase.a\|phase a"   # confirm Phase A landed
```

If working tree is dirty, abort. If Phase A commits aren't on main, abort and report — Phase B builds on Phase A.

## Your job

Create a git worktree at `../memry-i18n-phase-b` on a fresh branch `feature/i18n-phase-b`. Verify Phase A's infrastructure still works (live language switching), then leave the working tree clean for Task 01 to begin.

## Steps

1. Create the worktree:

```bash
git worktree add ../memry-i18n-phase-b -b feature/i18n-phase-b
```

2. Switch into the worktree:

```bash
cd ../memry-i18n-phase-b
```

3. Verify Phase A files exist:

```bash
ls packages/i18n/src/shared/config.ts
ls packages/i18n/src/renderer/use-t.ts
ls apps/desktop/src/main/ipc/locale-handler.ts
ls apps/desktop/tests/e2e/i18n.spec.ts
```

All four must exist. If any is missing, Phase A is incomplete — stop and report.

4. Install dependencies:

```bash
pnpm install
```

5. Smoke-test Phase A's runtime:

```bash
pnpm dev
```

In the running app:
- Open Settings → General → Language
- Switch to Türkçe → picker label flips to "Dil", toast confirms in Turkish, native menu rebuilds (File → Dosya)
- Switch to العربية → `<html dir>` becomes `rtl`, native menu rebuilds in Arabic
- Switch back to English → everything returns to English

If any step fails, Phase A has a regression — fix or report; **do not start Phase B on a broken base**.

6. Stop dev and verify clean state:

```bash
git status                         # clean
git log --oneline -3               # matches main
```

## Exit criteria

- [ ] Worktree exists at `../memry-i18n-phase-b`
- [ ] Branch `feature/i18n-phase-b` checked out
- [ ] `pnpm install` succeeded
- [ ] Phase A live-switching smoke test passed (en ↔ tr ↔ ar)
- [ ] Working tree clean

## Skills to use

None — pure setup.

## Report back

```
✅ Task 00 complete.
Worktree: ../memry-i18n-phase-b
Branch: feature/i18n-phase-b
Phase A smoke: ✅ en/tr/ar live switching works
Native menu rebuild: ✅
RTL: ✅
Next: Task 01 (expand en/common.json)
```
