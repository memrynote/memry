# Adding a New Locale to memry

This is the checklist to add language number 4, or any later language, to memry's i18n system.

## 1. Update the Locale enum

Edit `packages/contracts/src/locale-api.ts`:

```ts
export const LocaleSchema = z.enum(['en', 'tr', 'ar', 'es']) // added 'es'
```

## 2. Update the supported locales config

Edit `packages/i18n/src/shared/config.ts` and add the new entry to `LOCALE_DISPLAY_NAMES`:

```ts
export const LOCALE_DISPLAY_NAMES: Record<Locale, string> = {
  en: 'English',
  tr: 'Türkçe',
  ar: 'العربية',
  es: 'Español' // added; native script, never translated
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

Edit `packages/i18n/src/locales/index.ts`. Add imports for each `es/*.json` file, mirroring
the `en`, `tr`, and `ar` pattern, then add a top-level `es` block in the `RESOURCES` constant.

## 5. Translate strings

Populate the JSON files with translations. Any missing key should fall back to English through
i18next, so partial locale coverage is acceptable while the language is still being filled in.

## 6. Verify

```bash
pnpm --filter @memry/i18n typecheck
pnpm typecheck:desktop
pnpm --filter @memry/desktop exec playwright test --config config/playwright.config.ts ../tests/e2e/i18n.e2e.ts
```

## 7. Commit

```bash
git commit -m "feat(i18n): add Spanish locale"
```

The new language now appears in the Settings -> General -> Language picker automatically.
