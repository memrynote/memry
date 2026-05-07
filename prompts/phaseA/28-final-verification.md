# Task 28: Final verification and open PR

> **Plan:** Task 28 (Final Verification — All Checks Pass)
> **Depends on:** Tasks 25 (E2E), 26 (doc), 27 (CLAUDE.md) — and all upstream tasks
> **Dependents:** Phase B onward (which can begin once this PR merges)

## Pre-flight check

```bash
pwd                                                  # ../memry-i18n-phase-a
git status                                           # clean
git log --oneline | head -30                         # confirm all task commits present
```

You should see commits for Tasks 01 through 27 in order.

## Your job

Run the full verification suite, do a final manual smoke test, then open a pull request.

## Steps

### Verification gauntlet

1. **Lint**:

```bash
pnpm lint
```

Expected: passes.

2. **Typecheck (full workspace)**:

```bash
pnpm typecheck
```

Expected: passes. Per Memry's MEMORY.md, some test-file errors are pre-existing and ignored — that's fine. Source code in `packages/i18n` and `apps/desktop` must be clean.

3. **IPC contract check**:

```bash
pnpm ipc:check
```

Expected: passes.

4. **Unit + integration tests**:

```bash
pnpm test
```

Expected: all packages green, including new tests in `@memry/i18n` and `@memry/desktop`.

5. **Build the desktop bundle** (E2E needs this):

```bash
pnpm --filter @memry/desktop build
```

Expected: success. `out/main/index.js` exists.

6. **E2E**:

```bash
pnpm --filter @memry/desktop test:e2e
```

Expected: passes including new `i18n.spec.ts`.

### Manual smoke test

7. **Run dev mode**:

```bash
pnpm dev
```

Verify in the running app:

- App launches in English
- Settings → General → Language picker shows three options (English, Türkçe, العربية)
- Switch to Türkçe: settings UI flips to Turkish, native menu shows "Dosya"
- Switch to العربية: `<html dir="rtl">` applied, layout mirrors where logical classes apply, menu rebuilds in Arabic
- Restart app: locale persists to last selection

Stop dev (Ctrl+C).

### Open PR

8. **Push the branch**:

```bash
git push -u origin feature/i18n-phase-a
```

9. **Create the PR** using `gh`:

```bash
gh pr create --title "feat(i18n): Phase A — infrastructure" --body "$(cat <<'EOF'
## Summary

Ships the i18n infrastructure for Memry:

- New `@memry/i18n` shared package wrapping `react-i18next` + `i18next-icu`
- Main and renderer i18next instances with synchronous main-process boot
- Tightens `GeneralSettings.language` from loose string to strict enum (`en` | `tr` | `ar`)
- New `LocaleApi` IPC surface for atomic locale changes (persist + apply + broadcast)
- Native Electron menu rebuilds in the new language
- Document direction (`<html dir>`) flips for RTL locales via `Intl.Locale.textInfo`
- `mirror-rtl` Tailwind utility for opt-in icon flipping
- Settings → General → Language picker

**Zero existing UI strings migrated.** Phase B–E plans cover the migration of the ~939 renderer files and the lint gate.

Spec: docs/superpowers/specs/2026-04-29-i18n-multi-language-support-design.md
Plan: docs/superpowers/plans/2026-04-29-i18n-phase-a-infrastructure.md

## Test plan

- [x] `pnpm lint` passes
- [x] `pnpm typecheck` passes
- [x] `pnpm test` passes (all packages)
- [x] `pnpm ipc:check` passes
- [x] `pnpm test:e2e` passes (new `i18n.spec.ts`: live switch, RTL, menu rebuild)
- [x] Manual: switch to Turkish → menu shows "Dosya"
- [x] Manual: switch to Arabic → `<html dir="rtl">` applied
- [x] Manual: restart app → locale persists
EOF
)"
```

## Exit criteria

- [ ] All checks green: lint, typecheck, ipc:check, test, test:e2e
- [ ] Manual smoke confirms switching, RTL, persistence, menu rebuild
- [ ] Branch pushed
- [ ] PR opened with structured body and test plan checked off

## Skills to use

- **`superpowers:verification-before-completion`** — every check must actually pass; do not declare completion based on "should pass"
- **`superpowers:requesting-code-review`** (optional) — once PR is open, can request review

## Report back

```
✅ Task 28 complete — Phase A SHIPPED.
PR: <URL>
All checks: green
Manual smoke: pass
Phase A is ready for review and merge.

Next phases (each gets its own plan):
- Phase B: common namespace migration (~50 strings + TR/AR translations)
- Phase C: feature-by-feature string migration
- Phase D: main-process error strings
- Phase E: codemod sweep + ESLint gate + pnpm i18n:check
```
