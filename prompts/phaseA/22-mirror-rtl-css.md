# Task 22: Add `.mirror-rtl` global Tailwind class

> **Plan:** Task 22 (Add `mirror-rtl` Global Tailwind Class)
> **Depends on:** Task 21 (renderer boot in place — `<html dir>` will be set)
> **Dependents:** None — opt-in utility for future icon usage

> **Parallel-safe:** can run alongside Tasks 23, 26, 27 in any order.

## Pre-flight check

```bash
pwd                                                                 # ../memry-i18n-phase-a
git status                                                          # clean
grep -l "@tailwind\|@import.*tailwind" apps/desktop/src/renderer/ -r   # find global CSS entry
```

## Your job

Add a single CSS rule that mirrors elements opt-in via the `mirror-rtl` class when the document is RTL. Used for direction-pointing icons (chevrons, arrows). Most icons should NOT mirror — this is opt-in by design.

## Steps

1. **Open the global stylesheet.** From the grep above, the file is likely `apps/desktop/src/renderer/src/assets/main.css` or similar.

2. **Append at the end** (after Tailwind directives):

```css
/* RTL icon mirroring — opt-in via .mirror-rtl class.
   Most icons should NOT mirror in RTL (clocks, settings, magnifier).
   Direction-pointing icons (chevrons, arrows, breadcrumbs) opt in. */
[dir="rtl"] .mirror-rtl {
  transform: scaleX(-1);
}
```

3. **Verify build still works**:

```bash
pnpm dev
```

App boots with no CSS errors. Stop dev (Ctrl+C).

4. **Commit**:

```bash
git add apps/desktop/src/renderer/src/assets/main.css
git commit -m "feat(i18n): add .mirror-rtl utility for opt-in icon flipping"
```

## Exit criteria

- [ ] `[dir="rtl"] .mirror-rtl { transform: scaleX(-1); }` rule added to global CSS
- [ ] App still builds (`pnpm dev` succeeds)
- [ ] One commit

## Skills to use

None.

## Report back

```
✅ Task 22 complete.
Commit SHA: <abbrev>
CSS file modified: <path>
pnpm dev: builds clean
Next: Task 23 (settings language picker)
```
