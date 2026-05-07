# Task 27: Add Tailwind logical-class rule to CLAUDE.md

> **Plan:** Task 27 (Update `CLAUDE.md` with Tailwind Logical-Class Rule)
> **Depends on:** Task 21 (infrastructure complete)
> **Dependents:** None — this is project documentation that future PRs respect

> **Parallel-safe:** can run alongside Tasks 22, 26 in any order.

## Pre-flight check

```bash
pwd                                       # ../memry-i18n-phase-a
git status                                # clean
grep -n "Code Style\|## Style\|Prettier" CLAUDE.md | head -5    # find Code Style section
```

## Your job

Append a single rule to Memry's project `CLAUDE.md` mandating Tailwind logical classes for new code. This makes the convention reviewable in PRs and visible to anyone (human or AI) editing the codebase.

## Steps

1. **Find the Code Style section** in `CLAUDE.md` (project root). The grep above shows the line.

2. **Append to that section** the following:

```markdown
- **Tailwind logical properties (RTL safety)**: New code uses logical classes that flip automatically in RTL. Reject `ml-*` / `mr-*` (use `ms-*` / `me-*`), `pl-*` / `pr-*` (use `ps-*` / `pe-*`), `left-*` / `right-*` (use `start-*` / `end-*`), `text-left` / `text-right` (use `text-start` / `text-end`), `border-l` / `border-r` (use `border-s` / `border-e`), `rounded-l-*` / `rounded-r-*` (use `rounded-s-*` / `rounded-e-*`). Pre-existing files using physical classes are exempt (codemod is a future enhancement).
```

3. **Commit**:

```bash
git add CLAUDE.md
git commit -m "docs(i18n): add Tailwind logical-property rule to CLAUDE.md"
```

## Exit criteria

- [ ] CLAUDE.md has the new rule under Code Style
- [ ] One commit

## Skills to use

None.

## Report back

```
✅ Task 27 complete.
Commit SHA: <abbrev>
CLAUDE.md updated with Tailwind logical-class rule
Next: Task 28 (final verification + PR)
```
