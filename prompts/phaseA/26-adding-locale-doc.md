# Task 26: Document the "adding a new locale" checklist

> **Plan:** Task 26 (Add `docs/i18n-adding-a-locale.md`)
> **Depends on:** Task 21 (infrastructure complete)
> **Dependents:** None — this satisfies an acceptance criterion

> **Parallel-safe:** can run alongside Tasks 22, 27 in any order.

## Pre-flight check

```bash
pwd                                       # ../memry-i18n-phase-a
git status                                # clean
ls docs/                                  # see existing docs structure
```

## Your job

Create a one-page checklist documenting how to add language number 4 (or N) to memry. Lists the exact file edits, run commands, and commit message. The doc lives at the top level of `docs/` (not inside `superpowers/`) so it's discoverable as a contributor reference.

## Steps

1. **Create `docs/i18n-adding-a-locale.md`**:

````markdown
# Adding a New Locale to memry

This is the checklist to add language number 4 (or any subsequent language) to memry's i18n system.

## 1. Update the Locale enum

Edit `packages/contracts/src/locale-api.ts`:

```ts
export const LocaleSchema = z.enum(['en', 'tr', 'ar', 'es']) // added 'es'
```

## 2. Update the supported locales config

Edit `packages/i18n/src/shared/config.ts` — add the new entry to `LOCALE_DISPLAY_NAMES`:

```ts
export const LOCALE_DISPLAY_NAMES: Record<Locale, string> = {
  en: 'English',
  tr: 'Türkçe',
  ar: 'العربية',
  es: 'Español' // added — native script, never translated
}
```

## 3. Create the locale resource directory

```bash
mkdir packages/i18n/src/locales/es
for ns in common inbox notes journal calendar settings errors menu; do
  echo '{}' > packages/i18n/src/locales/es/$ns.json
done
```

## 4. Update the resources barrel

Edit `packages/i18n/src/locales/index.ts`. Add imports for each `es/*.json` file (mirror the `en:` / `tr:` / `ar:` pattern) and a top-level `es:` block in the `RESOURCES` constant.

## 5. Translate strings (optional for v1)

Populate the JSON files with translations. You can leave any file as `{}` if you don't have translations yet — i18next falls back to English automatically.

## 6. Verify

```bash
pnpm --filter @memry/i18n typecheck
pnpm typecheck:desktop
pnpm --filter @memry/desktop test:e2e i18n
```

## 7. Commit

```bash
git commit -m "feat(i18n): add Spanish locale"
```

The new language now appears in the Settings → General → Language picker automatically.
````

2. **Commit**:

```bash
git add docs/i18n-adding-a-locale.md
git commit -m "docs(i18n): add 'adding a locale' checklist"
```

## Exit criteria

- [ ] `docs/i18n-adding-a-locale.md` exists
- [ ] Doc lists all 7 steps (enum, config, resources, barrel, translate, verify, commit)
- [ ] One commit

## Skills to use

None — documentation.

## Report back

```
✅ Task 26 complete.
Commit SHA: <abbrev>
Doc: docs/i18n-adding-a-locale.md
Next: Task 27 (CLAUDE.md update)
```
