# Task 0b: Preflight — verify `react-i18next` peer-deps include React 19

> **Plan:** Task 0b (Risk Register Validations)
> **Depends on:** Task 00 (worktree exists)
> **Dependents:** Tasks 1, 17, 18, 19 (renderer i18n stack)

## Pre-flight check

```bash
pwd                                # should be ../memry-i18n-phase-a
git status                         # must be clean
```

## Your job

Confirm that the latest `react-i18next` declares React 19 in its `peerDependencies` range. If it doesn't, we'll either pin to a version that does, or accept warnings — but the answer informs Task 1's `package.json`.

## Steps

1. Inspect peer-dep range:

```bash
pnpm view react-i18next peerDependencies
```

Expected output includes `react: '^19.0.0'` or a range that subsumes 19 (e.g., `>=16.8.0`). As of 2026-04, `react-i18next@15.x` supports React 19.

2. Note the resolved version:

```bash
pnpm view react-i18next version
```

Record this version (e.g., `15.4.0`) — it goes into Task 1's `package.json`.

3. **Decision gate:**

   - **If react peer dep range supports 19:** proceed to Task 1.
   - **If only `^16 || ^17 || ^18`:** check older versions for React 19 support, or pick the closest version with explicit support. Update Task 1's planned version accordingly.

## Exit criteria

- [ ] Confirmed `react-i18next` peer-deps include React 19
- [ ] Recorded the resolved version number for Task 1's `package.json`

## Skills to use

None — this is dependency verification.

## Report back

```
✅ Task 0b complete.
react-i18next version: <recorded version, e.g. 15.4.0>
Peer-deps include react: <paste range>
Next: Task 1 (package skeleton)
```
