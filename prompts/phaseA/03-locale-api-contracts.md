# Task 03: Create `@memry/contracts/locale-api` (canonical Locale types)

> **Plan:** Task 10 of the plan, but reordered to come before i18n config per the plan's note
> **Depends on:** Task 02 (workspace links wired)
> **Dependents:** Tasks 04 (i18n config), 11 (settings tighten), 13 (channels), 14 (handler), 21 (preload bridge)

## Pre-flight check

```bash
pwd                                       # ../memry-i18n-phase-a
git status                                # clean
ls packages/contracts/src/                # see existing files
cat packages/contracts/package.json | head -50    # see exports pattern
```

## Your job

Create `packages/contracts/src/locale-api.ts` as the **single canonical home** for `LocaleSchema`, `Locale`, `SUPPORTED_LOCALES`, `FALLBACK_LOCALE`, and the `LocaleApi` IPC interface. All other packages import from here.

## Steps

1. Create `packages/contracts/src/locale-api.ts`:

```ts
import { z } from 'zod'

export const LocaleSchema = z.enum(['en', 'tr', 'ar'])
export type Locale = z.infer<typeof LocaleSchema>

export const SUPPORTED_LOCALES = LocaleSchema.options
export const FALLBACK_LOCALE: Locale = 'en'

/**
 * Renderer-side IPC bridge for runtime locale control. Distinct from the
 * existing settings IPC: `LocaleApi.set` atomically persists the
 * `GeneralSettings.language` field AND triggers a runtime change
 * (instance.changeLanguage + native menu rebuild + broadcast).
 */
export interface LocaleApi {
  get: () => Promise<Locale>
  set: (locale: Locale) => Promise<void>
  list: () => Promise<readonly Locale[]>
}
```

2. Add the export to `packages/contracts/package.json`. In the `exports` field, alphabetical position, insert:

```json
"./locale-api": "./src/locale-api.ts",
```

3. Run typecheck:

```bash
pnpm --filter @memry/contracts typecheck
```

Expected: passes.

4. Commit:

```bash
git add packages/contracts/src/locale-api.ts packages/contracts/package.json
git commit -m "feat(i18n): add LocaleSchema and LocaleApi contract"
```

## Exit criteria

- [ ] `packages/contracts/src/locale-api.ts` exists with `LocaleSchema`, `Locale`, `SUPPORTED_LOCALES`, `FALLBACK_LOCALE`, `LocaleApi`
- [ ] `packages/contracts/package.json` has the new `./locale-api` export
- [ ] `pnpm --filter @memry/contracts typecheck` passes
- [ ] One commit created

## Skills to use

None — straight implementation against the spec.

## Report back

```
✅ Task 03 complete.
Commit SHA: <abbrev>
typecheck: passes
Next: Task 04 (shared/config.ts)
```
