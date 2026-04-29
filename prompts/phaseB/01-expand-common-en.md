# Task 01: Expand `en/common.json` with the universal vocabulary

> **Plan:** Task 1 (Expand English `common.json` with the Universal Vocabulary)
> **Depends on:** Task 00 (worktree set up)
> **Dependents:** Tasks 02, 03, 04, 05–13 (all migrations rely on these keys)

## Pre-flight check

```bash
pwd                                                          # ../memry-i18n-phase-b
git status                                                   # clean
cat packages/i18n/src/locales/en/common.json                 # confirm Phase A seed (button.save/cancel/close)
```

## Your job

Replace `packages/i18n/src/locales/en/common.json` with the full universal vocabulary: ~42 keys across `button`, `state`, `empty`, `action`, and `count` (ICU plural) groups. This is purely additive — Phase A's three keys are preserved.

## Steps

1. Overwrite `packages/i18n/src/locales/en/common.json` with:

```json
{
  "button": {
    "save": "Save",
    "cancel": "Cancel",
    "close": "Close",
    "ok": "OK",
    "yes": "Yes",
    "no": "No",
    "delete": "Delete",
    "confirm": "Confirm",
    "apply": "Apply",
    "done": "Done",
    "discard": "Discard",
    "edit": "Edit",
    "add": "Add",
    "remove": "Remove",
    "retry": "Retry",
    "submit": "Submit",
    "back": "Back",
    "next": "Next",
    "continue": "Continue",
    "reset": "Reset",
    "copy": "Copy",
    "paste": "Paste",
    "create": "Create",
    "open": "Open"
  },
  "state": {
    "loading": "Loading…",
    "saving": "Saving…",
    "deleting": "Deleting…",
    "searching": "Searching…",
    "error": "Error",
    "success": "Success"
  },
  "empty": {
    "noResults": "No results",
    "noItems": "No items",
    "noMatch": "No matches"
  },
  "action": {
    "search": "Search",
    "edit": "Edit",
    "delete": "Delete",
    "close": "Close"
  },
  "count": {
    "item": "{count, plural, one {# item} other {# items}}",
    "note": "{count, plural, one {# note} other {# notes}}",
    "folder": "{count, plural, one {# folder} other {# folders}}",
    "task": "{count, plural, one {# task} other {# tasks}}",
    "project": "{count, plural, one {# project} other {# projects}}"
  }
}
```

Notes (do **not** add as comments — JSON has no comments):
- `state.loading` uses Unicode ellipsis `…` (single character), not three ASCII dots — macOS HIG convention.
- `count.*` uses ICU plural syntax with `#` as the count placeholder.
- `action.*` is intentionally separate from `button.*` so translators can use a different register for ARIA labels vs. visible buttons.

2. Validate JSON:

```bash
node -e "JSON.parse(require('fs').readFileSync('packages/i18n/src/locales/en/common.json', 'utf8'))" && echo OK
```

Expected: prints `OK`.

3. Verify TypeScript picks up the new keys:

```bash
pnpm --filter @memry/i18n typecheck
```

Expected: passes. The type augmentation in `packages/i18n/src/shared/types.ts` reads from this JSON, so autocomplete on `t('common:…')` now sees `button.delete`, `count.item`, etc.

4. Run existing i18n tests to ensure nothing regresses:

```bash
pnpm --filter @memry/i18n test
```

Expected: all Phase A tests pass.

5. Commit:

```bash
git add packages/i18n/src/locales/en/common.json
git commit -m "feat(i18n): expand en/common.json with universal vocabulary"
```

## Exit criteria

- [ ] File contains 42+ keys across button/state/empty/action/count
- [ ] JSON is valid
- [ ] `@memry/i18n` typecheck passes
- [ ] `@memry/i18n` test passes
- [ ] One commit created

## Skills to use

None — straight content addition.

## Report back

```
✅ Task 01 complete.
Commit SHA: <abbrev>
Keys added: 42 (button: 24, state: 6, empty: 3, action: 4, count: 5)
Next: Task 02 (translate to Turkish)
```
