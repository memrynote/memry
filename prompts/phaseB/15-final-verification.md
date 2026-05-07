# Task 15: Final verification + open PR

> **Plan:** Task 15 (Final Verification — All Checks Pass)
> **Depends on:** Tasks 00–14 all committed
> **Dependents:** Phase B complete

## Pre-flight check

```bash
pwd                                                              # ../memry-i18n-phase-b
git status                                                       # clean
git log --oneline main..HEAD                                     # should show 14 commits (00 has none, 01–14 each one or two)
```

If the commit count is wildly off, audit which tasks were skipped before continuing.

## Your job

Run the full verification gauntlet (lint, typecheck, IPC contract, unit tests, e2e), do a manual smoke walkthrough of every migrated touchpoint, then push the branch and open the PR.

## Steps

1. **Lint**

```bash
pnpm lint
```

Expected: passes.

2. **Typecheck (full workspace)**

```bash
pnpm typecheck
```

Expected: passes (modulo Memry's known pre-existing test-file errors per MEMORY.md). If `pnpm ipc:check` flakes inside the typecheck pipeline, fall back per MEMORY.md gotcha:

```bash
pnpm typecheck:node && pnpm typecheck:web
```

3. **IPC contract check**

```bash
pnpm ipc:check
```

Expected: passes. Phase B added zero new IPC surface — this is regression coverage.

4. **Unit + integration tests**

```bash
pnpm test
```

Expected: all packages green. New tests:

- `packages/i18n/src/shared/icu-plural.test.ts` (Task 04)
- `apps/desktop/src/renderer/src/components/bulk/delete-confirmation-dialog.test.tsx` (Task 06)

…plus all Phase A tests still passing.

5. **E2E**

```bash
pnpm --filter @memry/desktop build
pnpm --filter @memry/desktop test:e2e
```

Expected: passes including extended `i18n.spec.ts` (4 scenarios).

6. **Manual smoke test — every migrated touchpoint**

```bash
pnpm dev
```

Walk the checklist:

- [ ] Settings → General → Language: switch to Türkçe.
- [ ] Try to close a tab with unsaved edits → buttons read "Kaydet" / "Vazgeç" / "İptal".
- [ ] Bulk-select inbox items → press Delete → buttons read "İptal" + "5 öğeyi sil".
- [ ] Right-click a folder/note in sidebar → Delete → Cancel reads "İptal".
- [ ] Right-click a task → Delete → Cancel reads "İptal".
- [ ] Right-click a calendar event → Delete → Cancel reads "İptal".
- [ ] Open folder view that triggers loading → "Yükleniyor…".
- [ ] Settings → Account: subtitle reads "Yükleniyor…" while loading.
- [ ] Calendar toolbar Search button → DevTools → `aria-label="Ara"`.
- [ ] Folder view → Column selector → row subtitles read "5 not" instead of "5 notes".

Switch to Arabic and verify:

- [ ] All of the above flip to Arabic translations.
- [ ] `<html dir="rtl">` set; layout flips for components using logical Tailwind classes.
- [ ] Cancel buttons read "إلغاء"; Loading reads "جارٍ التحميل…"; counts use Arabic plural categories.

If any item fails, fix the regression in the relevant task's file, commit with `fix(i18n): ...`, and re-run the checklist.

7. **Push the branch**

```bash
git push -u origin feature/i18n-phase-b
```

8. **Open the PR**

```bash
gh pr create --title "feat(i18n): Phase B — common namespace + migrations" --body "$(cat <<'EOF'
## Summary

Builds on the Phase A infrastructure by:

- Expanding `packages/i18n/src/locales/{en,tr,ar}/common.json` with ~50 universal strings — button verbs, state labels, empty-state text, ARIA action labels, and ICU-pluralized counts.
- Migrating ~12 renderer files to use the new keys via `useT('common')`. Targets cover four representative shapes:
  - Simple verb buttons (Cancel, Save, Discard) in unsaved-changes / delete-confirmation dialogs.
  - ICU-pluralized verb-with-count (`Delete N items`).
  - State labels (`Loading…`) in folder view and settings panels.
  - ARIA labels (`aria-label="Search"`) in calendar toolbar and window controls.
  - Pure plural counts (`N notes` in column-selector subtitles).
- First real exercise of `i18next-icu` pluralization, with a unit-test matrix covering English (`one`/`other`), Turkish (no plural -s), and Arabic (six CLDR categories).
- Extended e2e (`i18n.spec.ts`) asserts that migrated renderer-process strings flip live, not just the settings picker label.

Phase B is the proof-of-concept for end-to-end live language switching: switching to Türkçe in the running app now visibly affects renderer UI beyond the settings panel itself. Untranslated keys still fall back to English per Phase A's plumbing — nothing breaks.

**Out of scope:** feature-specific copy (titles like "Delete folder", inbox-zero text, note-editor chrome) — those land in Phase C per-feature plans. Error and main-process strings land in Phase D. The `pnpm i18n:check` lint gate lands in Phase E.

## Test plan

- [ ] `pnpm lint` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm ipc:check` passes
- [ ] `pnpm test` passes (new ICU plural test + new dialog component test)
- [ ] `pnpm test:e2e` passes including extended `i18n.spec.ts` (4 scenarios)
- [ ] Manual: switch to Türkçe → bulk delete dialog shows "İptal" + "5 öğeyi sil"
- [ ] Manual: switch to Türkçe → unsaved-changes dialog shows "Kaydet" / "Vazgeç" / "İptal"
- [ ] Manual: switch to Arabic → Loading reads "جارٍ التحميل…", `<html dir="rtl">`
- [ ] Manual: switch to Arabic → ICU plural picks correct category (1 → "عنصر واحد", 2 → "عنصران", 11 → "11 عنصراً")

## Translation review

- Turkish strings reviewed by Kaan (project owner, native speaker).
- Arabic strings seeded by Claude/DeepL at infra-validation quality. A native-speaker review is tracked separately as a content task.
EOF
)"
```

9. **Capture the PR URL** and report it back.

## Exit criteria

- [ ] All five gates pass: lint, typecheck, ipc:check, unit tests, e2e
- [ ] Manual smoke checklist clean (en + tr + ar)
- [ ] Branch pushed
- [ ] PR opened with the body above
- [ ] PR URL captured in report

## Skills to use

`superpowers:verification-before-completion` — do not claim done before every gate is green.

## Report back

```
✅ Task 15 complete. Phase B ready for review.
Lint: ✅
Typecheck: ✅
IPC check: ✅
Unit tests: <N> passing (Phase A + 2 new from Phase B)
E2E: 4/4 (i18n.spec.ts)
Manual smoke (en/tr/ar): ✅
PR: <URL>
```
