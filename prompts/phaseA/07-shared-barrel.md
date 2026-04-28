# Task 07: Create `packages/i18n/src/shared/index.ts` barrel

> **Plan:** Task 6 (Update `shared/index.ts` Barrel)
> **Depends on:** Tasks 04, 05, 06 (config, direction, types exist)
> **Dependents:** Anyone importing from `@memry/i18n/shared`

## Pre-flight check

```bash
pwd                                                       # ../memry-i18n-phase-a
git status                                                # clean
ls packages/i18n/src/shared/{config,direction,types}.ts  # all three exist
```

## Your job

Create the public barrel for `@memry/i18n/shared` exporting `config` and `direction` runtime exports. `types.ts` is augmentation-only and exports nothing at runtime.

## Steps

1. Create `packages/i18n/src/shared/index.ts`:

```ts
export * from './config'
export * from './direction'
```

2. Run typecheck on the i18n package:

```bash
pnpm --filter @memry/i18n typecheck
```

Expected: **still fails** about JSON imports in `types.ts` (`Cannot find module '../locales/en/common.json'`). This is fixed by Task 08.

3. Commit:

```bash
git add packages/i18n/src/shared/index.ts
git commit -m "feat(i18n): export shared config and direction"
```

## Exit criteria

- [ ] `packages/i18n/src/shared/index.ts` exists
- [ ] One commit created

## Skills to use

None.

## Report back

```
✅ Task 07 complete.
Commit SHA: <abbrev>
Typecheck status: still BROKEN (JSON imports unresolved — fixed by Task 08)
Next: Task 08 (locale resource JSONs)
```
