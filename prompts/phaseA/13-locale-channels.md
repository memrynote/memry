# Task 13: Add `LocaleChannels` constants to `@memry/contracts/ipc-channels`

> **Plan:** Task 13 (Implement IPC Channel Constant for `locale:changed`)
> **Depends on:** Task 12 (IPC contract clean state)
> **Dependents:** Tasks 14, 21 (handler + preload bridge)

## Pre-flight check

```bash
pwd                                                              # ../memry-i18n-phase-a
git status                                                       # clean
head -30 packages/contracts/src/ipc-channels.ts                  # see existing pattern
```

Look at how existing constants like `SettingsChannels` are structured — match the pattern.

## Your job

Append a `LocaleChannels` const enum-like object to `packages/contracts/src/ipc-channels.ts` covering the four channels the locale subsystem uses: `Get`, `Set`, `List`, and `Changed` (broadcast).

## Steps

1. **Find the export location** in `packages/contracts/src/ipc-channels.ts`. Append at the end of the file (or wherever the existing constants live):

```ts
export const LocaleChannels = {
  Get: 'locale:get',
  Set: 'locale:set',
  List: 'locale:list',
  Changed: 'locale:changed'
} as const
```

2. Run typecheck:

```bash
pnpm --filter @memry/contracts typecheck
```

Expected: passes.

3. Run any existing channel tests to confirm no regression:

```bash
pnpm --filter @memry/contracts test ipc-channels
```

Expected: passes.

4. Commit:

```bash
git add packages/contracts/src/ipc-channels.ts
git commit -m "feat(i18n): add LocaleChannels IPC constants"
```

## Exit criteria

- [ ] `LocaleChannels` exported from `ipc-channels.ts`
- [ ] All four channel names present (`Get`, `Set`, `List`, `Changed`)
- [ ] Typecheck passes
- [ ] One commit

## Skills to use

None — small additive change.

## Report back

```
✅ Task 13 complete.
Commit SHA: <abbrev>
Typecheck: passes
Next: Task 14 (locale-handler, TDD)
```
