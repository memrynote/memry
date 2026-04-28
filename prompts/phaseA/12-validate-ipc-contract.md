# Task 12: Validate IPC contract boundary

> **Plan:** Task 12 (Validate IPC Contract Boundary)
> **Depends on:** Task 11 (settings schema tightened)
> **Dependents:** Tasks 13, 14, 21 (locale channels + handler + preload)

## Pre-flight check

```bash
pwd                                       # ../memry-i18n-phase-a
git status                                # clean
git log --oneline -3                      # latest: "feat(i18n): tighten GeneralSettings.language..."
```

## Your job

Run `pnpm ipc:check` to verify the renderer↔main IPC boundary still type-checks after the `language` schema tightening. If regenerated types changed, commit them; if no changes, no commit.

## Steps

1. Run the validator:

```bash
pnpm ipc:check
```

Expected: passes.

2. **If failures**, the regenerated types may need updating. Run:

```bash
pnpm ipc:generate
pnpm ipc:check
```

3. Check what changed:

```bash
git status
```

If `apps/desktop/src/preload/generated-rpc.ts` or `apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts` changed, those are auto-generated and must be committed.

4. Commit only if changes occurred:

```bash
git diff --quiet || git add apps/desktop/src/preload/generated-rpc.ts apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts
git diff --cached --quiet || git commit -m "chore(i18n): regenerate IPC types after schema tightening"
```

## Exit criteria

- [ ] `pnpm ipc:check` passes
- [ ] Any regenerated IPC files committed (or no commit if nothing changed)

## Skills to use

- **`superpowers:verification-before-completion`** — confirm `ipc:check` passes before moving on

## Report back

```
✅ Task 12 complete.
ipc:check: passes
Regenerated files: <"none changed" or "committed in <SHA>">
Next: Task 13 (LocaleChannels constants)
```
